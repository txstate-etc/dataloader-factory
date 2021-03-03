/* eslint-disable @typescript-eslint/no-useless-constructor */
import stringify from 'fast-json-stable-stringify'
import DataLoader from 'dataloader'

export abstract class Loader<KeyType, ReturnType, FilterType> {
  public idLoaders: PrimaryKeyLoader<any, ReturnType>[]

  constructor (public config: any) {
    this.idLoaders = config.idLoader ? (Array.isArray(config.idLoader) ? config.idLoader : [config.idLoader]) : []
  }

  abstract init (factory: DataLoaderFactory): any
  abstract getDataLoader (cached: any, filters?: FilterType): DataLoader<KeyType, ReturnType|undefined, string>|DataLoader<KeyType, ReturnType[], string>
}

export interface LoaderConfig<KeyType, ReturnType> {
  fetch: (ids: KeyType[], context: any) => Promise<ReturnType[]>
  extractId?: (item: ReturnType) => KeyType
  idLoader?: PrimaryKeyLoader<any, ReturnType>|PrimaryKeyLoader<any, ReturnType>[]
  options?: DataLoader.Options<KeyType, ReturnType, string>
}
export class PrimaryKeyLoader<KeyType, ReturnType> extends Loader<KeyType, ReturnType, never> {
  constructor (public config: LoaderConfig<KeyType, ReturnType>) {
    super(config)
    this.extractId = config.extractId ?? defaultId
    config.options ??= {}
    config.options.maxBatchSize ??= 1000
    config.options.cacheKeyFn ??= stringify
  }

  init (factory: DataLoaderFactory) {
    return new DataLoader<KeyType, ReturnType, string>(async (ids: readonly KeyType[]): Promise<any[]> => {
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
    }, this.config.options)
  }

  getDataLoader (cached: DataLoader<KeyType, ReturnType|undefined, string>) {
    return cached
  }

  extractId: (obj: ReturnType) => KeyType
}

export interface ManyJoinedType<KeyType, ReturnType> {
  key: KeyType
  value: ReturnType
}
export interface BaseManyLoaderConfig<KeyType, ReturnType> {
  skipCache?: boolean
  maxBatchSize?: number
  cacheKeyFn?: (key: KeyType) => string
  idLoader?: PrimaryKeyLoader<any, ReturnType>|PrimaryKeyLoader<any, ReturnType>[]
}
export abstract class BaseManyLoader<KeyType, ReturnType, FilterType> extends Loader<KeyType, ReturnType, FilterType> {
  constructor (public config: BaseManyLoaderConfig<KeyType, ReturnType>) {
    super(config)
    this.config.cacheKeyFn ??= stringify
    this.config.maxBatchSize ??= 1000;
    (this.config as any).useCache = !this.config.skipCache
  }

  protected factory!: DataLoaderFactory
  init (factory: DataLoaderFactory) {
    this.factory = factory
    return new Map()
  }

  prime (loader: PrimaryKeyLoader<any, ReturnType>, items: any) {
    for (const item of items) {
      this.factory.get(loader).prime(loader.extractId(item), item)
    }
  }

  abstract groupItems (items: ReturnType[]|ManyJoinedType<KeyType, ReturnType>[], dedupekeys: Map<string, KeyType>): Record<string, ReturnType[]>

  getDataLoader (cached: Map<string, FilteredStorageObject<KeyType, ReturnType>>, filters?: FilterType) {
    const filterstring = stringify(filters)
    let storageObject = cached.get(filterstring)
    if (!storageObject) {
      const cache = this.config.skipCache ? undefined : new Map<string, Promise<ReturnType[]>>()
      storageObject = {
        cache,
        loader: new DataLoader<KeyType, ReturnType[], string>(async (keys: readonly KeyType[]): Promise<(Error | ReturnType[])[]> => {
          const stringkeys: string[] = keys.map(this.config.cacheKeyFn!)
          const dedupekeys: Map<string, KeyType> = new Map()
          for (let i = 0; i < keys.length; i++) {
            dedupekeys.set(stringkeys[i], keys[i])
          }
          const items = await (this.config as any).fetch(Array.from(dedupekeys.values()), filters, this.factory.context)
          for (const loader of this.idLoaders) {
            this.prime(loader, items)
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

export interface OneToManyLoaderConfig<KeyType, ReturnType, FilterType> extends BaseManyLoaderConfig<KeyType, ReturnType> {
  fetch: (keys: KeyType[], filters: FilterType, context: any) => Promise<ReturnType[]>
  extractKey?: (item: ReturnType) => KeyType
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
      this.groupItems = (items: ReturnType[]) => {
        const ret = {}
        for (const item of items) {
          pushRecord(ret, this.config.cacheKeyFn!(config.extractKey!(item)), item)
        }
        return ret
      }
    } else {
      throw new Error('Tried to create a one-to-many loader without either extractKey or matchKey defined. One of the two is required.')
    }
  }

  groupItems: (items: ReturnType[], dedupekeys: Map<string, KeyType>) => Record<string, ReturnType[]>
}

export interface ManyJoinedLoaderConfig<KeyType, ReturnType, FilterType> extends BaseManyLoaderConfig<KeyType, ReturnType> {
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

  prime (loader: PrimaryKeyLoader<any, ReturnType>, items: ManyJoinedType<KeyType, ReturnType>[]) {
    for (const item of items) {
      this.factory.get(loader).prime(loader.extractId(item.value), item.value)
    }
  }
}

export interface ManyToManyLoaderConfig<KeyType, ReturnType, FilterType> extends BaseManyLoaderConfig<KeyType, ReturnType> {
  fetch: (keys: KeyType[], filters: FilterType, context: any) => Promise<ReturnType[]>
  extractKeys?: (item: ReturnType) => KeyType[]
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
      this.groupItems = (items: ReturnType[]) => {
        const ret = {}
        for (const item of items) {
          for (const key of config.extractKeys!(item)) pushRecord(ret, this.config.cacheKeyFn!(key), item)
        }
        return ret
      }
    } else {
      throw new Error('Tried to create a many-to-many loader without either extractKeys or matchKey defined. One of the two is required.')
    }
  }

  groupItems: (items: ReturnType[], dedupekeys: Map<string, KeyType>) => Record<string, ReturnType[]>
}

export interface FilteredStorageObject<KeyType, ReturnType> {
  loader: DataLoader<KeyType, ReturnType[], string>
  cache?: Map<string, Promise<ReturnType[]>>
}

function defaultId (item: any) {
  return item.id || item._id
}

function pushRecord (record: { [keys: string]: any[] }, key: string, item: any) {
  if (!record[key]) record[key] = []
  record[key].push(item)
}

export class DataLoaderFactory<ContextType = any> {
  private loaders: Map<Loader<any, any, any>, DataLoader<any, any, string>|Map<string, FilteredStorageObject<any, any>>>
  public context: ContextType

  constructor (context?: ContextType) {
    this.loaders = new Map()
    this.context = context ?? {} as any
  }

  get<KeyType, ReturnType> (loader: PrimaryKeyLoader<KeyType, ReturnType>): DataLoader<KeyType, ReturnType|undefined, string>
  get<KeyType, ReturnType, FilterType> (loader: BaseManyLoader<KeyType, ReturnType, FilterType>, filters?: FilterType): DataLoader<KeyType, ReturnType[], string>
  get<KeyType = any, ReturnType = any, FilterType = any> (loader: Loader<KeyType, ReturnType, FilterType>, filters?: FilterType): DataLoader<KeyType, ReturnType|undefined, string>|DataLoader<KeyType, ReturnType[], string> {
    let loaderCache = this.loaders.get(loader)
    if (!loaderCache) {
      loaderCache = loader.init(this as any)
      this.loaders.set(loader, loaderCache as any)
    }
    return loader.getDataLoader(loaderCache, filters)
  }

  async loadMany<KeyType, ReturnType> (loader: PrimaryKeyLoader<KeyType, ReturnType>, keys: KeyType[]): Promise<ReturnType[]>
  async loadMany<KeyType, ReturnType, FilterType> (loader: BaseManyLoader<KeyType, ReturnType, FilterType>, keys: KeyType[], filters?: FilterType): Promise<ReturnType[]>
  async loadMany<KeyType, ReturnType, FilterType> (loader: Loader<KeyType, ReturnType, FilterType>, keys: KeyType[], filter?: FilterType) {
    if (loader instanceof PrimaryKeyLoader) {
      return (await Promise.all(keys.map(async k => await this.get(loader).load(k)))).filter(r => typeof r !== 'undefined')
    } else if (loader instanceof BaseManyLoader) {
      return (await Promise.all(keys.map(async k => await this.get(loader, filter).load(k)))).flat()
    }
    return []
  }

  getCache<KeyType, ReturnType, FilterType>(loader: BaseManyLoader<KeyType, ReturnType, FilterType>, filters?: FilterType): Map<string, Promise<ReturnType[]>> {
    const cached = this.loaders.get(loader)
    if (cached instanceof DataLoader) throw new Error('Cannot get cache for a primary key loader. Pass it a Map of your own in options.cacheMap instead.')
    if (!cached) return new Map()
    const cache = loader.getCache(cached, filters)
    if (!cache) throw new Error('Cannot get cache for a loader that has the skipCache option enabled.')
    return cache
  }
}
