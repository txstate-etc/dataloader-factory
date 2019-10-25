import stringify from 'fast-json-stable-stringify'
import DataLoader from 'dataloader'

export interface FilteredLoaderConfig {
  // function that should pull the foreign key out of the result object
  // must match the interface of the keys you're using in your fetch function
  extractKey (item:any): any|any[]
  // accept arbitrary foreign keys and arbitrary arguments and return results
  // this is where your database logic goes
  // the foreign keys MUST appear in the result objects so that your
  // extractKey function can retrieve them
  fetch (keys: any[], filters:any): Promise<any[]>
  // generated dataloaders will not keep a cache
  skipCache?: boolean
  // maxBatchSize to be passed to each DataLoader
  maxBatchSize?: number
  // cacheKeyFn to be passed to each DataLoader
  cacheKeyFn? (key:any): string
  // each call to DataLoader.load() should return an array instead of
  // a single value
  returnOne?: boolean
  // provide idLoaderKey to automatically prime the
  // id-based dataloader with any results gathered
  idLoaderKey?: string
}

export interface LoaderConfig {
  fetch (ids:any[]): Promise<any[]>
  extractId? (item:any): any
  options?: DataLoader.Options<any,any>
}

interface FilteredStorageObject {
  loader: DataLoader<any,any>
  cache?: Map<string,any>
}
export class DataLoaderFactory {
  private static registry:{ [keys:string]: LoaderConfig } = {}
  static register(key:string, loaderConfig:LoaderConfig) {
    DataLoaderFactory.registry[key] = loaderConfig
  }
  private static filteredregistry:{ [keys:string]: FilteredLoaderConfig } = {}
  static registerFiltered (key:string, loader:FilteredLoaderConfig) {
    DataLoaderFactory.filteredregistry[key] = loader
  }

  private loaders: { [keys:string]: DataLoader<any,any> }
  get (key:string):DataLoader<any,any> {
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
  getFiltered (key:string, filters:any={}):DataLoader<any,any> {
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
      const grouped = items.reduce((grouped, item) => {
        let keys = loaderConfig.extractKey(item)
        if (!Array.isArray(keys)) keys = [keys]
        for (const key of keys) {
          const keystr = stringify(key)
          if (loaderConfig.returnOne) {
            grouped[keystr] = item
          } else {
            if (!grouped[keystr]) grouped[keystr] = []
            grouped[keystr].push(item)
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
