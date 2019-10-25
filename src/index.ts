import stringify from 'fast-json-stable-stringify'
import DataLoader from 'dataloader'

export interface FilteredLoaderConfig<KeyType = any, ReturnType = any, FilterType = any> {
  // accept arbitrary foreign keys and arbitrary arguments and return results
  // this is where your database logic goes
  // the foreign keys MUST appear in the result objects so that your
  // extractKey function can retrieve them
  fetch (keys: KeyType[], filters:FilterType): Promise<ReturnType[]>
  // function that should pull the foreign key out of the result object
  // must match the interface of the keys you're using in your fetch function
  extractKey? (item:ReturnType): KeyType|KeyType[]
  // in rare cases it may be that a key cannot be extracted from an item because
  // an irreversible operation is involved (like evaluating greater than or less than)
  // in those cases, you can provide this matchKey function that examines
  // whether the result object is a match for the given key; the answer
  // will help us put the fetched dataset back together properly
  matchKey?: (key:KeyType, item:ReturnType) => boolean
  // generated dataloaders will not keep a cache
  skipCache?: boolean
  // maxBatchSize to be passed to each DataLoader
  maxBatchSize?: number
  // cacheKeyFn to be passed to each DataLoader
  cacheKeyFn? (key:KeyType): string
  // each call to DataLoader.load() should return an array instead of
  // a single value
  returnOne?: boolean
  // provide idLoaderKey to automatically prime the
  // id-based dataloader with any results gathered
  idLoaderKey?: string
}

export interface LoaderConfig<KeyType = any, ReturnType = any> {
  fetch (ids:KeyType[]): Promise<ReturnType[]>
  extractId? (item:ReturnType): KeyType
  options?: DataLoader.Options<KeyType,ReturnType>
}

interface FilteredStorageObject<KeyType = any, ReturnType = any> {
  loader: DataLoader<KeyType,ReturnType>
  cache?: Map<string,ReturnType>
}
export class DataLoaderFactory {
  private static registry:{ [keys:string]: LoaderConfig } = {}
  static register<KeyType = any, ReturnType = any> (key:string, loaderConfig:LoaderConfig<KeyType,ReturnType>) {
    DataLoaderFactory.registry[key] = loaderConfig
  }
  private static filteredregistry:{ [keys:string]: FilteredLoaderConfig } = {}
  static registerFiltered<KeyType = any, ReturnType = any> (key:string, loader:FilteredLoaderConfig<KeyType,ReturnType>) {
    if (!loader.extractKey && !loader.matchKey) throw new Error('Tried to register a filtered dataloader without either extractKey or matchKey defined. One of the two is required.')
    if (loader.extractKey && loader.matchKey) throw new Error('Registered a filtered dataloader with both extractKey and matchKey defined. Only one of these may be provided.')
    DataLoaderFactory.filteredregistry[key] = loader
  }

  private loaders: { [keys:string]: DataLoader<any,any> }
  get<KeyType = any, ReturnType = any> (key:string):DataLoader<KeyType,ReturnType> {
    const loaderConfig = DataLoaderFactory.registry[key]
    if (!loaderConfig) throw new Error('Called DataLoaderFactory.get() with an unregistered key.')
    if (!this.loaders[key]) this.loaders[key] = this.generateIdLoader(loaderConfig)
    return this.loaders[key]
  }
  private generateIdLoader (loaderConfig:LoaderConfig):DataLoader<any,any> {
    return new DataLoader<any,any>(async (ids:any[]):Promise<any[]> => {
      const items = await loaderConfig.fetch(ids)
      const keyed = items.reduce((keyed, item) => {
        const key = stringify(loaderConfig.extractId ? loaderConfig.extractId(item) : item.id || item._id)
        keyed[key] = item
        return keyed
      }, {})
      return ids.map(stringify).map(id => keyed[id])
    }, loaderConfig.options || {})
  }

  private filteredloaders: { [keys:string]: {
    [keys:string]: FilteredStorageObject
  }}
  constructor () {
    this.loaders = {}
    this.filteredloaders = {}
  }
  getFiltered<KeyType = any, ReturnType = any> (key:string, filters:any={}):DataLoader<KeyType,ReturnType> {
    const loaderConfig = DataLoaderFactory.filteredregistry[key]
    if (!loaderConfig) throw new Error('Called DataLoaderFactory.getFiltered() with an unregistered key.')
    if (!this.filteredloaders[key]) this.filteredloaders[key] = {}
    const filtered = this.filteredloaders[key]
    const filterkey = stringify(filters)
    if (!filtered[filterkey]) filtered[filterkey] = this.generateFilteredLoader(filters, loaderConfig)
    return filtered[filterkey].loader
  }
  getFilteredcache (key:string, filters:any):Map<string,any>|undefined {
    const filterkey = stringify(filters)
    return ((this.filteredloaders[key] || {})[filterkey] || {}).cache
  }
  private generateFilteredLoader (filters:any, loaderConfig:FilteredLoaderConfig):FilteredStorageObject {
    const cache = loaderConfig.skipCache ? undefined : new Map<string, any>()
    const loader = new DataLoader<any,any>(async (keys:any[]):Promise<any[]> => {
      const stringkeys:string[] = keys.map(stringify)
      const dedupekeys:any = {}
      for (let i = 0; i < keys.length; i++) {
        dedupekeys[stringkeys[i]] = keys[i]
      }
      const items = await loaderConfig.fetch(Object.values(dedupekeys), filters)
      if (loaderConfig.idLoaderKey) {
        const idLoader = this.get(loaderConfig.idLoaderKey)
        if (idLoader) {
          const idLoaderConfig = DataLoaderFactory.registry[loaderConfig.idLoaderKey]
          for (const item of items) {
            const id = idLoaderConfig.extractId ? idLoaderConfig.extractId(item) : item.id || item._id
            if (id) idLoader.prime(id, item)
          }
        }
      }

      const addtogrouped = (grouped:{ [keys:string]: any }, key: any, item:any) => {
        const keystr = stringify(key)
        if (loaderConfig.returnOne) {
          grouped[keystr] = item
        } else {
          if (!grouped[keystr]) grouped[keystr] = []
          grouped[keystr].push(item)
        }
      }
      const grouped = items.reduce((grouped, item) => {
        if (loaderConfig.extractKey) {
          let keyorkeys = loaderConfig.extractKey(item)
          if (Array.isArray(keyorkeys)) for (const key of keyorkeys) addtogrouped(grouped, key, item)
          else addtogrouped(grouped, keyorkeys, item)
        } else if (loaderConfig.matchKey) {
          for (const key of Object.values(dedupekeys)) {
            if (loaderConfig.matchKey(key, item)) addtogrouped(grouped, key, item)
          }
        }
        return grouped
      }, {})
      return stringkeys.map(key => grouped[key] || (loaderConfig.returnOne ? undefined : []))
    }, {
      cacheKeyFn: loaderConfig.cacheKeyFn || stringify,
      cache: !loaderConfig.skipCache,
      cacheMap: cache,
      maxBatchSize: loaderConfig.maxBatchSize || 1000
    })
    return { loader, cache }
  }
}
