/* eslint-disable @typescript-eslint/no-useless-constructor */
import { stringify, unique } from 'txstate-utils'
import DataLoader from 'dataloader'

type MatchingKeyof<T, V> = keyof { [ P in keyof T as T[P] extends V ? P : never ]: P }

export abstract class Loader<KeyType, ReturnType, FilterType> {
  public idLoaders: PrimaryKeyLoader<any, ReturnType>[]

  constructor (public config: any) {
    this.idLoaders = config.idLoader ? (Array.isArray(config.idLoader) ? config.idLoader : [config.idLoader]) : []
  }

  abstract init (factory: DataLoaderFactory): any
  abstract getDataLoader (cached: any, factory: DataLoaderFactory, filters?: FilterType): DataLoader<KeyType, ReturnType | undefined, string> | DataLoader<KeyType, ReturnType[], string>
  addIdLoader (loader: PrimaryKeyLoader<any, ReturnType>) {
    this.idLoaders.push(loader)
  }
}

export interface LoaderConfig<KeyType, ReturnType> {
  fetch: (ids: KeyType[], context: any) => Promise<ReturnType[]>
  extractId?: MatchingKeyof<ReturnType, KeyType> | ((item: ReturnType) => KeyType)
  idLoader?: PrimaryKeyLoader<any, ReturnType> | PrimaryKeyLoader<any, ReturnType>[]
  options?: DataLoader.Options<KeyType, ReturnType, string>
}
export class PrimaryKeyLoader<KeyType, ReturnType> extends Loader<KeyType, ReturnType, never> {
  extractId: (obj: ReturnType) => KeyType

  constructor (public config: LoaderConfig<KeyType, ReturnType>) {
    super(config)
    const extractId = config.extractId ?? defaultId
    if (typeof extractId === 'function') {
      this.extractId = extractId
    } else {
      this.extractId = (itm: any) => itm[extractId]
    }
    this.config.options = {
      ...this.config.options,
      maxBatchSize: config.options?.maxBatchSize ?? 1000,
      cacheKeyFn: config.options?.cacheKeyFn ?? stringify
    }
  }

  init (factory: DataLoaderFactory) {
    const cacheMap = this.config.options!.cacheMap ?? new Map()
    const dl = new DataLoader<KeyType, ReturnType, string>(async (ids: readonly KeyType[]): Promise<any[]> => {
      const items = await this.config.fetch(ids as KeyType[], factory.context)
      for (const idLoader of this.idLoaders) {
        for (const item of items) {
          factory.get(idLoader).prime(idLoader.extractId(item), item)
        }
      }
      const keyed = items.reduce((keyed: Map<any, ReturnType>, item) => {
        const key = this.config.options!.cacheKeyFn!(this.extractId(item))
        keyed.set(key, item)
        return keyed
      }, new Map())
      return ids.map(this.config.options!.cacheKeyFn!).map(id => keyed.get(id))
    }, { ...this.config.options, cacheMap });
    (dl as any).cacheMap = cacheMap
    return dl
  }

  getDataLoader (cached: DataLoader<KeyType, ReturnType | undefined, string>) {
    return cached
  }
}

export interface ManyJoinedType<KeyType, ReturnType> {
  key: KeyType
  value: ReturnType
}
export interface BaseManyLoaderConfig<KeyType, ReturnType, FilterType> {
  skipCache?: boolean
  maxBatchSize?: number
  cacheKeyFn?: (key: KeyType) => string
  keysFromFilter?: (filter: FilterType | undefined) => KeyType[]
  idLoader?: PrimaryKeyLoader<any, ReturnType> | PrimaryKeyLoader<any, ReturnType>[]
}
export abstract class BaseManyLoader<KeyType, ReturnType, FilterType> extends Loader<KeyType, ReturnType, FilterType> {
  constructor (public config: BaseManyLoaderConfig<KeyType, ReturnType, FilterType>) {
    super(config)
    this.config.cacheKeyFn ??= stringify
    this.config.maxBatchSize ??= (config as any).matchKey ? 50 : 1000;
    (this.config as any).useCache = !this.config.skipCache
  }

  init (factory: DataLoaderFactory) {
    return new Map()
  }

  prime (loader: PrimaryKeyLoader<any, ReturnType>, factory: DataLoaderFactory, items: any) {
    for (const item of items) {
      factory.get(loader).prime(loader.extractId(item), item)
    }
  }

  abstract groupItems (items: ReturnType[] | ManyJoinedType<KeyType, ReturnType>[], dedupekeys: Map<string, KeyType>): Record<string, ReturnType[]>
  abstract filterItems (items: ReturnType[] | ManyJoinedType<KeyType, ReturnType>[], filters: FilterType | undefined): ReturnType[] | ManyJoinedType<KeyType, ReturnType>[]

  getDataLoader (cached: Map<string, FilteredStorageObject<KeyType, ReturnType>>, factory: DataLoaderFactory, filters?: FilterType) {
    const filterstring = stringify(filters)
    let storageObject = cached.get(filterstring)
    if (!storageObject) {
      const cache = this.config.skipCache ? undefined : new Map<string, Promise<ReturnType[]>>()
      storageObject = {
        cache,
        loader: new DataLoader<KeyType, ReturnType[], string>(async (keys: readonly KeyType[]): Promise<(Error | ReturnType[])[]> => {
          const stringkeys: string[] = keys.map(this.config.cacheKeyFn!)
          const dedupekeys = new Map<string, KeyType>()
          for (let i = 0; i < keys.length; i++) {
            dedupekeys.set(stringkeys[i], keys[i])
          }
          const items = this.filterItems(
            await (this.config as any).fetch(Array.from(dedupekeys.values()), filters, factory.context),
            filters
          )

          for (const loader of this.idLoaders) {
            this.prime(loader, factory, items)
          }

          const grouped = this.groupItems(items, dedupekeys)
          return stringkeys.map(key => grouped[key] || [])
        }, {
          cacheKeyFn: this.config.cacheKeyFn,
          cache: (this.config as any).useCache,
          cacheMap: cache,
          maxBatchSize: this.config.maxBatchSize
        })
      }
      cached.set(filterstring, storageObject)
    }
    return storageObject.loader
  }

  getCache (cached: Map<string, FilteredStorageObject<KeyType, ReturnType>>, filters?: FilterType) {
    return cached.get(stringify(filters))?.cache
  }
}

export interface OneToManyLoaderConfig<KeyType, ReturnType, FilterType> extends BaseManyLoaderConfig<KeyType, ReturnType, FilterType> {
  fetch: (keys: KeyType[], filters: FilterType, context: any) => Promise<ReturnType[]>
  extractKey?: MatchingKeyof<ReturnType, KeyType> | ((item: ReturnType) => KeyType)
  matchKey?: (key: KeyType, item: ReturnType) => boolean
}
export class OneToManyLoader<KeyType, ReturnType, FilterType = undefined> extends BaseManyLoader<KeyType, ReturnType, FilterType> {
  constructor (config: OneToManyLoaderConfig<KeyType, ReturnType, FilterType>) {
    super(config)
    if (config.matchKey) {
      this.groupItems = (items: ReturnType[], dedupekeys: Map<string, KeyType>) => {
        const ret = {}
        for (const item of items) {
          for (const key of dedupekeys.values()) {
            if (config.matchKey!(key, item)) pushRecord(ret, this.config.cacheKeyFn!(key), item)
          }
        }
        return ret
      }
    } else if (config.extractKey) {
      if (typeof config.extractKey !== 'function') {
        const extractKey = config.extractKey
        config.extractKey = (itm: any) => itm[extractKey]
      }
      const extractFn = config.extractKey as (itm: ReturnType) => KeyType
      this.groupItems = (items: ReturnType[]) => {
        const ret = {}
        for (const item of items) {
          pushRecord(ret, this.config.cacheKeyFn!(extractFn(item)), item)
        }
        return ret
      }
    } else {
      throw new Error('Tried to create a one-to-many loader without either extractKey or matchKey defined. One of the two is required.')
    }
    if (config.keysFromFilter != null && config.extractKey) {
      const keysFromFilter = config.keysFromFilter
      const extractFn = config.extractKey as (itm: ReturnType) => KeyType
      this.filterItems = (items, filters) => {
        const keys = new Set(keysFromFilter(filters).map(this.config.cacheKeyFn!))
        if (keys.size === 0) return items
        return items.filter(itm => keys.has(this.config.cacheKeyFn!(extractFn(itm))))
      }
    } else {
      this.filterItems = items => items
    }
  }

  filterItems: (items: ReturnType[], filters: FilterType | undefined) => ReturnType[]
  groupItems: (items: ReturnType[], dedupekeys: Map<string, KeyType>) => Record<string, ReturnType[]>
}

export interface ManyJoinedLoaderConfig<KeyType, ReturnType, FilterType> extends BaseManyLoaderConfig<KeyType, ReturnType, FilterType> {
  fetch: (keys: KeyType[], filters: FilterType, context: any) => Promise<ManyJoinedType<KeyType, ReturnType>[]>
}
export class ManyJoinedLoader<KeyType, ReturnType, FilterType = undefined> extends BaseManyLoader<KeyType, ReturnType, FilterType> {
  constructor (config: ManyJoinedLoaderConfig<KeyType, ReturnType, FilterType>) {
    super(config)
  }

  groupItems (items: ManyJoinedType<KeyType, ReturnType>[]) {
    const ret: Record<string, ReturnType[]> = {}
    for (const { key, value } of items) {
      pushRecord(ret, this.config.cacheKeyFn!(key), value)
    }
    return ret
  }

  filterItems (items: ManyJoinedType<KeyType, ReturnType>[], filters: FilterType | undefined) {
    if (!this.config.keysFromFilter) return items
    const keys = new Set(this.config.keysFromFilter(filters).map(this.config.cacheKeyFn!))
    if (keys.size === 0) return items
    return items.filter(itm => keys.has(this.config.cacheKeyFn!(itm.key)))
  }

  prime (loader: PrimaryKeyLoader<any, ReturnType>, factory: DataLoaderFactory, items: ManyJoinedType<KeyType, ReturnType>[]) {
    for (const item of items) {
      factory.get(loader).prime(loader.extractId(item.value), item.value)
    }
  }
}

export interface ManyToManyLoaderConfig<KeyType, ReturnType, FilterType> extends BaseManyLoaderConfig<KeyType, ReturnType, FilterType> {
  fetch: (keys: KeyType[], filters: FilterType, context: any) => Promise<ReturnType[]>
  extractKeys?: MatchingKeyof<ReturnType, KeyType[]> | ((item: ReturnType) => KeyType[])
  matchKey?: (key: KeyType, item: ReturnType) => boolean
}
export class ManyToManyLoader<KeyType, ReturnType, FilterType = undefined> extends BaseManyLoader<KeyType, ReturnType, FilterType> {
  constructor (config: ManyToManyLoaderConfig<KeyType, ReturnType, FilterType>) {
    super(config)
    if (config.matchKey) {
      this.groupItems = (items: ReturnType[], dedupekeys: Map<string, KeyType>) => {
        const ret = {}
        for (const item of items) {
          for (const key of dedupekeys.values()) {
            if (config.matchKey!(key, item)) pushRecord(ret, this.config.cacheKeyFn!(key), item)
          }
        }
        return ret
      }
    } else if (config.extractKeys) {
      if (typeof config.extractKeys !== 'function') {
        const extractKeys = config.extractKeys
        config.extractKeys = (itm: any) => itm[extractKeys]
      }
      const extractFn = config.extractKeys as (itm: ReturnType) => KeyType[]

      this.groupItems = (items: ReturnType[]) => {
        const ret = {}
        for (const item of items) {
          for (const key of extractFn(item)) pushRecord(ret, this.config.cacheKeyFn!(key), item)
        }
        return ret
      }
    } else {
      throw new Error('Tried to create a many-to-many loader without either extractKeys or matchKey defined. One of the two is required.')
    }
    if (config.keysFromFilter != null && config.extractKeys) {
      const keysFromFilter = config.keysFromFilter
      const extractFn = config.extractKeys as (itm: ReturnType) => KeyType[]
      this.filterItems = (items, filters) => {
        const keys = new Set(keysFromFilter(filters).map(this.config.cacheKeyFn!))
        if (keys.size === 0) return items
        return items.filter(itm => extractFn(itm).some(k => keys.has(this.config.cacheKeyFn!(k))))
      }
    } else {
      this.filterItems = items => items
    }
  }

  filterItems: (items: ReturnType[], filters: FilterType | undefined) => ReturnType[]
  groupItems: (items: ReturnType[], dedupekeys: Map<string, KeyType>) => Record<string, ReturnType[]>
}

export interface ParentDocumentLoaderConfig<KeyType, ReturnType> {
  fetch: (ids: KeyType[], context: any) => Promise<ReturnType[]>
  childIds: (item: ReturnType) => KeyType[]
  parentId?: MatchingKeyof<ReturnType, KeyType> | ((item: ReturnType) => KeyType)
  idLoader?: PrimaryKeyLoader<any, ReturnType> | PrimaryKeyLoader<any, ReturnType>[]
  options?: DataLoader.Options<KeyType, ReturnType, string>
}
export class ParentDocumentLoader<KeyType, ReturnType> extends Loader<KeyType, ReturnType, never> {
  childIds: (obj: ReturnType) => KeyType[]
  parentId: (obj: ReturnType) => KeyType

  constructor (public config: ParentDocumentLoaderConfig<KeyType, ReturnType>) {
    super(config)
    this.childIds = config.childIds
    const parentId = config.parentId ?? defaultId
    if (typeof parentId === 'function') {
      this.parentId = parentId
    } else {
      this.parentId = (itm: any) => itm[parentId]
    }
    this.config.options = {
      ...this.config.options,
      maxBatchSize: config.options?.maxBatchSize ?? 1000,
      cacheKeyFn: config.options?.cacheKeyFn ?? stringify
    }
  }

  init (factory: DataLoaderFactory) {
    const cacheMap = this.config.options!.cacheMap ?? new Map()
    const dl = new DataLoader<KeyType, ReturnType, string>(async (ids: readonly KeyType[]): Promise<any[]> => {
      const items = await this.config.fetch(ids as KeyType[], factory.context)
      for (const idLoader of this.idLoaders) {
        for (const item of items) {
          factory.get(idLoader).prime(idLoader.extractId(item), item)
        }
      }
      const keyed = items.reduce((keyed: Map<any, ReturnType>, item) => {
        const keys = this.childIds(item).map(this.config.options!.cacheKeyFn!)
        for (const key of keys) keyed.set(key, item)
        return keyed
      }, new Map())
      return ids.map(this.config.options!.cacheKeyFn!).map(id => keyed.get(id))
    }, { ...this.config.options, cacheMap });
    (dl as any).cacheMap = cacheMap
    return dl
  }

  getDataLoader (cached: DataLoader<KeyType, ReturnType | undefined, string>) {
    return cached
  }
}

export interface BestMatchLoaderConfig<KeyType, ReturnType> extends Omit<LoaderConfig<KeyType, ReturnType>, 'extractId'> {
  fetch: (keys: KeyType[], context: any) => Promise<ReturnType[]>
  scoreMatch?: (key: KeyType, item: ReturnType) => number
}
export class BestMatchLoader<KeyType, ReturnType> extends Loader<KeyType, ReturnType, never> {
  constructor (config: BestMatchLoaderConfig<KeyType, ReturnType>) {
    super(config)
    this.config.options = {
      ...this.config.options,
      maxBatchSize: config.options?.maxBatchSize ?? 100,
      cacheKeyFn: config.options?.cacheKeyFn ?? stringify
    }
  }

  init (factory: DataLoaderFactory) {
    const cacheMap = this.config.options!.cacheMap ?? new Map()
    const dl = new DataLoader<KeyType, ReturnType, string>(async (keys: readonly KeyType[]): Promise<any[]> => {
      const items = await this.config.fetch(keys as KeyType[], factory.context)
      for (const idLoader of this.idLoaders) {
        for (const item of items) factory.get(idLoader).prime(idLoader.extractId(item), item)
      }
      const keyed = new Map<KeyType, { score: number, item: ReturnType }>()
      for (const item of items) {
        for (const key of keys) {
          const score = this.config.scoreMatch(key, item)
          if (score === 0) continue
          if (!keyed.has(key) || keyed.get(key)!.score < score) keyed.set(key, { score, item })
        }
      }
      return keys.map(key => keyed.get(key)?.item)
    }, { ...this.config.options, cacheMap });
    (dl as any).cacheMap = cacheMap
    return dl
  }

  getDataLoader (cached: DataLoader<KeyType, ReturnType | undefined, string>) {
    return cached
  }
}

export interface FilteredStorageObject<KeyType, ReturnType> {
  loader: DataLoader<KeyType, ReturnType[], string>
  cache?: Map<string, Promise<ReturnType[]>>
}

function defaultId (item: any) {
  return item.id || item._id
}

function pushRecord (record: Record<string, any[]>, key: string, item: any) {
  if (!record[key]) record[key] = []
  record[key].push(item)
}

export class DataLoaderFactory<ContextType = any> {
  private loaders: Map<Loader<any, any, any>, DataLoader<any, any, string> | Map<string, FilteredStorageObject<any, any>>>
  public context: ContextType

  constructor (context?: ContextType) {
    this.loaders = new Map()
    this.context = context ?? {} as any
  }

  get<KeyType, ReturnType> (loader: PrimaryKeyLoader<KeyType, ReturnType>): DataLoader<KeyType, ReturnType | undefined, string>
  get<KeyType, ReturnType> (loader: BestMatchLoader<KeyType, ReturnType>): DataLoader<KeyType, ReturnType | undefined, string>
  get<KeyType, ReturnType, FilterType> (loader: BaseManyLoader<KeyType, ReturnType, FilterType>, filters?: FilterType): DataLoader<KeyType, ReturnType[], string>
  get<KeyType = any, ReturnType = any, FilterType = any> (loader: Loader<KeyType, ReturnType, FilterType>, filters?: FilterType): DataLoader<KeyType, ReturnType | undefined, string> | DataLoader<KeyType, ReturnType[], string> {
    let loaderCache = this.loaders.get(loader)
    if (!loaderCache) {
      loaderCache = loader.init(this as any)
      this.loaders.set(loader, loaderCache as any)
    }
    return loader.getDataLoader(loaderCache, this, filters)
  }

  async loadMany<KeyType, ReturnType> (loader: PrimaryKeyLoader<KeyType, ReturnType>, keys: KeyType[]): Promise<ReturnType[]>
  async loadMany<KeyType, ReturnType> (loader: ParentDocumentLoader<KeyType, ReturnType>, keys: KeyType[]): Promise<ReturnType[]>
  async loadMany<KeyType, ReturnType> (loader: BestMatchLoader<KeyType, ReturnType>, keys: KeyType[]): Promise<ReturnType[]>
  async loadMany<KeyType, ReturnType, FilterType> (loader: BaseManyLoader<KeyType, ReturnType, FilterType>, keys: KeyType[], filters?: FilterType): Promise<ReturnType[]>
  async loadMany<KeyType, ReturnType, FilterType> (loader: Loader<KeyType, ReturnType, FilterType>, keys: KeyType[], filter?: FilterType) {
    if (loader instanceof ParentDocumentLoader) {
      const dl = this.get(loader as ParentDocumentLoader<KeyType, ReturnType>)
      const parentDocs = await Promise.all(keys.map(async k => await dl.load(k)))
      return unique(parentDocs.filter(r => r != null), loader.parentId)
    } else if (loader instanceof PrimaryKeyLoader || loader instanceof BestMatchLoader) {
      const dl = this.get(loader as PrimaryKeyLoader<KeyType, ReturnType> | BestMatchLoader<KeyType, ReturnType>)
      return (await Promise.all(keys.map(async k => await dl.load(k)))).filter(r => typeof r !== 'undefined')
    } else if (loader instanceof BaseManyLoader) {
      const dl = this.get(loader, filter)
      return (await Promise.all(keys.map(async k => await dl.load(k)))).flat()
    }
    return []
  }

  getCache<KeyType, ReturnType, FilterType>(loader: PrimaryKeyLoader<KeyType, ReturnType>, filters?: FilterType): Map<string, Promise<ReturnType>> | undefined
  getCache<KeyType, ReturnType, FilterType>(loader: BestMatchLoader<KeyType, ReturnType>, filters?: FilterType): Map<string, Promise<ReturnType>> | undefined
  getCache<KeyType, ReturnType, FilterType>(loader: BaseManyLoader<KeyType, ReturnType, FilterType>, filters?: FilterType): Map<string, Promise<ReturnType[]>> | undefined
  getCache<KeyType, ReturnType, FilterType>(loader: PrimaryKeyLoader<KeyType, ReturnType> | BestMatchLoader<KeyType, ReturnType> | BaseManyLoader<KeyType, ReturnType, FilterType>, filters?: FilterType): Map<string, Promise<ReturnType[]>> | undefined {
    const cached = this.loaders.get(loader)
    if (!cached) return undefined
    if (loader instanceof PrimaryKeyLoader || loader instanceof BestMatchLoader) return (cached as any).cacheMap
    const cache = loader.getCache(cached as Map<string, FilteredStorageObject<any, any>>, filters)
    if (!cache) throw new Error('Cannot get cache for a loader that has the skipCache option enabled.')
    return cache
  }

  clear () {
    this.loaders = new Map()
  }
}
