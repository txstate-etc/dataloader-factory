import stringify from 'fast-json-stable-stringify'
import DataLoader from 'dataloader'

interface BaseManyLoaderConfig<KeyType, ReturnType> {
  matchKey?: (key:KeyType, item:ReturnType) => boolean
  skipCache?: boolean
  maxBatchSize?: number
  cacheKeyFn? (key:KeyType): string
  idLoaderKey?: string
}

interface OneToManyLoaderConfig<KeyType = any, ReturnType = any, FilterType = any> extends BaseManyLoaderConfig<KeyType, ReturnType> {
  fetch (keys: KeyType[], filters:FilterType): Promise<ReturnType[]>
  extractKey? (item:ReturnType): KeyType
}

interface ManyJoinedLoaderConfig<KeyType = any, ReturnType = any, FilterType = any> extends BaseManyLoaderConfig<KeyType, ReturnType> {
  fetch (keys: KeyType[], filters: FilterType): Promise<{ key: KeyType, value: ReturnType }[]>
}

interface ManyToManyLoaderConfig<KeyType = any, ReturnType = any, FilterType = any> extends BaseManyLoaderConfig<KeyType, ReturnType> {
  fetch (keys: KeyType[], filters:FilterType): Promise<ReturnType[]>
  extractKeys? (item:ReturnType): KeyType[]
}

interface LoaderConfig<KeyType = any, ReturnType = any> {
  fetch (ids:KeyType[]): Promise<ReturnType[]>
  extractId? (item:ReturnType): KeyType
  options?: DataLoader.Options<KeyType,ReturnType>
}

interface FilteredStorageObject<KeyType = any, ReturnType = any> {
  loader: DataLoader<KeyType,ReturnType[]>
  cache?: Map<string,Promise<ReturnType[]>>
}

function defaultId (item: any) {
  return item.id || item._id
}

export class DataLoaderFactory {
  private static registry:{ [keys:string]: LoaderConfig } = {}
  private static filteredregistry:{ [keys:string]: OneToManyLoaderConfig|ManyToManyLoaderConfig|ManyJoinedLoaderConfig } = {}
  private loaders: { [keys:string]: DataLoader<any,any> }
  private filteredloaders: { [keys:string]: { [keys:string]: FilteredStorageObject }}

  constructor () {
    this.loaders = {}
    this.filteredloaders = {}
  }

  static register<KeyType = any, ReturnType = any> (key:string, loaderConfig:LoaderConfig<KeyType,ReturnType>) {
    DataLoaderFactory.registry[key] = loaderConfig
  }

  static registerOneToMany<KeyType = any, ReturnType = any> (key: string, loader: OneToManyLoaderConfig<KeyType, ReturnType>) {
    if (!loader.extractKey && !loader.matchKey) throw new Error('Tried to register a filtered dataloader without either extractKey or matchKey defined. One of the two is required.')
    if (loader.extractKey && loader.matchKey) throw new Error('Registered a filtered dataloader with both extractKey and matchKey defined. Only one of these may be provided.')
    DataLoaderFactory.filteredregistry[key] = loader
  }

  static registerManyToMany<KeyType = any, ReturnType = any> (key: string, loader: ManyToManyLoaderConfig<KeyType, ReturnType>) {
    if (!loader.extractKeys && !loader.matchKey) throw new Error('Tried to register a many-to-many dataloader without either extractKeys or matchKey defined. One of the two is required.')
    DataLoaderFactory.filteredregistry[key] = loader
  }

  static registerManyJoined<KeyType = any, ReturnType = any> (key: string, loader: ManyJoinedLoaderConfig<KeyType, ReturnType>) {
    DataLoaderFactory.filteredregistry[key] = loader
  }

  get<KeyType = any, ReturnType = any> (key:string):DataLoader<KeyType,ReturnType> {
    const loaderConfig = DataLoaderFactory.registry[key]
    if (!loaderConfig) throw new Error('Called DataLoaderFactory.get() with an unregistered key.')
    if (!this.loaders[key]) this.loaders[key] = this.generateIdLoader(loaderConfig)
    return this.loaders[key]
  }
  private generateIdLoader <KeyType, ReturnType>(loaderConfig:LoaderConfig):DataLoader<KeyType,ReturnType> {
    const options = loaderConfig.options || {}
    if (!options.maxBatchSize) options.maxBatchSize = 1000
    return new DataLoader<KeyType,ReturnType,string>(async (ids:readonly any[]):Promise<any[]> => {
      const items = await loaderConfig.fetch(ids as any[])
      const keyed = items.reduce((keyed, item) => {
        const key = stringify(loaderConfig.extractId ? loaderConfig.extractId(item) : defaultId(item))
        keyed[key] = item
        return keyed
      }, {})
      return ids.map(stringify).map(id => keyed[id])
    }, options || {})
  }

  getOneToMany<KeyType = any, ReturnType = any> (key: string, filters: any = {}): DataLoader<KeyType, ReturnType[]> {
    const loaderConfig = DataLoaderFactory.filteredregistry[key]
    if (!loaderConfig) throw new Error('Tried to retrieve a dataloader from DataLoaderFactory with an unregistered key.')
    if (!this.filteredloaders[key]) this.filteredloaders[key] = {}
    const filtered = this.filteredloaders[key]
    const filterkey = stringify(filters)
    if (!filtered[filterkey]) filtered[filterkey] = this.generateFilteredLoader(filters, loaderConfig)
    return filtered[filterkey].loader
  }

  getManyToMany<KeyType = any, ReturnType = any, FilterType = any> (key: string, filters: FilterType = {} as FilterType): DataLoader<KeyType, ReturnType[]> {
    return this.getOneToMany(key, filters)
  }

  getManyJoined<KeyType = any, ReturnType = any, FilterType = any> (key: string, filters: any = {}): DataLoader<KeyType, ReturnType[]> {
    return this.getOneToMany(key, filters)
  }

  getFilteredcache (key:string, filters:any):Map<string,any>|undefined {
    const filterkey = stringify(filters)
    return ((this.filteredloaders[key] || {})[filterkey] || {}).cache
  }

  private prime<KeyType, ReturnType> (loaderConfig: BaseManyLoaderConfig<KeyType, ReturnType>, items: ReturnType[]) {
    if (loaderConfig.idLoaderKey) {
      const idLoader = this.get(loaderConfig.idLoaderKey)
      if (idLoader) {
        const idLoaderConfig = DataLoaderFactory.registry[loaderConfig.idLoaderKey]
        for (const item of items) {
          const id = idLoaderConfig.extractId ? idLoaderConfig.extractId(item) : defaultId(item)
          if (id) idLoader.prime(id, item)
        }
      }
    }
  }

  private generateFilteredLoader <KeyType, ReturnType> (filters:any, loaderConfig:OneToManyLoaderConfig<KeyType, ReturnType>|ManyToManyLoaderConfig<KeyType, ReturnType>|ManyJoinedLoaderConfig<KeyType, ReturnType>):FilteredStorageObject<KeyType, ReturnType> {
    const cache = loaderConfig.skipCache ? undefined : new Map<string, Promise<ReturnType[]>>()
    const loader = new DataLoader<KeyType, ReturnType[], string>(async (keys:readonly KeyType[]):Promise<(Error | ReturnType[])[]> => {
      const stringkeys:string[] = keys.map(stringify)
      const dedupekeys:{ [keys:string]: KeyType } = {}
      for (let i = 0; i < keys.length; i++) {
        dedupekeys[stringkeys[i]] = keys[i]
      }
      const items = await loaderConfig.fetch(Object.values(dedupekeys), filters)
      if ('matchKey' in loaderConfig) {
        this.prime(loaderConfig, items as ReturnType[])
      } else {
        this.prime(loaderConfig, (items as { key: KeyType, value: ReturnType }[]).map(item => item.value))
      }

      const grouped: { [keys:string]: ReturnType[]} = {}
      const addtogrouped = (key: any, item:any) => {
        const keystr = stringify(key)
        if (!grouped[keystr]) grouped[keystr] = []
        grouped[keystr].push(item)
      }
      for (const item of items) {
        if ('extractKey' in loaderConfig && loaderConfig.extractKey) {
          let key = loaderConfig.extractKey(item as ReturnType)
          addtogrouped(key, item)
        } else if ('extractKeys' in loaderConfig && loaderConfig.extractKeys) {
          let keys = loaderConfig.extractKeys(item as ReturnType)
          for (const key of keys) addtogrouped(key, item)
        } else if ('matchKey' in loaderConfig && loaderConfig.matchKey) {
          const actualitem = 'key' in item && 'value' in item ? item.value : item as ReturnType
          for (const key of Object.values(dedupekeys)) {
            if (loaderConfig.matchKey(key, actualitem)) addtogrouped(key, actualitem)
          }
        } else if ('key' in item) {
          addtogrouped(item.key, item.value)
        }
      }
      return stringkeys.map(key => grouped[key] || [])
    }, {
      cacheKeyFn: loaderConfig.cacheKeyFn || stringify,
      cache: !loaderConfig.skipCache,
      cacheMap: cache,
      maxBatchSize: loaderConfig.maxBatchSize || 1000
    })
    return { loader, cache }
  }
}
