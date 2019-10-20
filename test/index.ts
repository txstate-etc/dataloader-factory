import yaml from 'js-yaml'
import { promises as fsp } from 'fs'
import { DataLoaderFactory } from '../src/index'
import { expect } from 'chai'

async function getData (type:string):Promise<any[]> {
  const ymlstring = await fsp.readFile(`test/data/${type}.yml`, 'utf-8')
  return yaml.safeLoad(ymlstring)
}

DataLoaderFactory.registerFiltered('booksByAuthorId', {
  returnMany: true,
  fetch: async (keys, filters) => {
    const allbooks = await getData('books')
    return allbooks.filter(book => keys.includes(book.authorId) && book.genres.includes(filters.genre))
  },
  extractKey: (item) => item.authorId
})

describe('bookloader', () => {
  it('should be able to load books by authorId', async () => {
    const dataLoaderFactory = new DataLoaderFactory()
    const loader = dataLoaderFactory.filtered('booksByAuthorId', { genre: 'mystery' })
    const authoryml = await fsp.readFile('test/data/authors.yml', 'utf-8')
    const authors = yaml.safeLoad(authoryml)
    const authorBooks = await loader.loadMany(authors.map((a:any) => a.id))
    expect(authorBooks).to.have.length(6)
    for (const books of authorBooks) {
      for (const book of books) {
        expect(book.genres).to.include('mystery')
      }
    }
  })
})
