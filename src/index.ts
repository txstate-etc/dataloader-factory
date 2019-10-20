import stringify from 'fast-json-stable-stringify'
import DataLoader from 'dataloader'

export interface FilteredLoaderConfig {
  returnMany?: boolean
  fetch (keys: any[], filters:any):Promise<any[]>
  extractKey (item:any):any
}

function generateFilteredLoader (filters:any, loaderConfig:FilteredLoaderConfig):DataLoader<any,any> {
  return new DataLoader<any,any>(async (keys:any[]):Promise<any[]> => {
    const stringkeys:string[] = keys.map(stringify)
    const dedupekeys:any = {}
    for (let i = 0; i < keys.length; i++) {
      dedupekeys[stringkeys[i]] = keys[i]
    }
    const items = await loaderConfig.fetch(Object.values(dedupekeys), filters)
    const grouped = items.reduce((grouped, item) => {
      const key = stringify(loaderConfig.extractKey(item))
      if (loaderConfig.returnMany) {
        if (!grouped[key]) grouped[key] = []
        grouped[key].push(item)
      } else {
        grouped[key] = item
      }
      return grouped
    }, {})
    return stringkeys.map(key => grouped[key] || (loaderConfig.returnMany ? [] : undefined))
  })
}

export class DataLoaderFactory {
  private static filteredregistry:{ [keys:string]: FilteredLoaderConfig } = {}
  static registerFiltered (key:string, loader:FilteredLoaderConfig) {
    DataLoaderFactory.filteredregistry[key] = loader
  }

  private filteredcache: { [keys:string]: {
    [keys:string]: DataLoader<any,any>
  }}
  constructor () {
    this.filteredcache = {}
  }
  filtered (key:string, filters:any):DataLoader<any,any> {
    const loaderConfig = DataLoaderFactory.filteredregistry[key]
    if (!loaderConfig) throw new Error('Called DataLoaderFactory.filtered() with an unregistered key.')
    if (!this.filteredcache[key]) this.filteredcache[key] = {}
    const filtered = this.filteredcache[key]
    const filterkey = stringify(filters)
    if (!filtered[filterkey]) filtered[filterkey] = generateFilteredLoader(filters, loaderConfig)
    return filtered[filterkey]
  }
}
