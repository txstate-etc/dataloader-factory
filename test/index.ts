import yaml from 'js-yaml'
import { promises as fsp } from 'fs'
import { DataLoaderFactory } from '../src/index'
import { expect } from 'chai'

async function getData (type:string):Promise<any[]> {
  const ymlstring = await fsp.readFile(`test/data/${type}.yml`, 'utf-8')
  return yaml.safeLoad(ymlstring)
}

const BOOKS_BY_AUTHOR_ID = 'booksByAuthorId'
DataLoaderFactory.registerFiltered(BOOKS_BY_AUTHOR_ID, {
  fetch: async (keys, filters) => {
    const allbooks = await getData('books')
    return allbooks.filter(book => keys.includes(book.authorId) && book.genres.includes(filters.genre))
  },
  extractKey: (item) => item.authorId
})

describe('bookloader', () => {
  const dataLoaderFactory = new DataLoaderFactory()
  it('should be able to load books by authorId', async () => {
    const loader = dataLoaderFactory.getFiltered(BOOKS_BY_AUTHOR_ID, { genre: 'mystery' })
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
  it('should return an empty array for an unrecognized authorId', async () => {
    const loader = dataLoaderFactory.getFiltered(BOOKS_BY_AUTHOR_ID)
    const authorBooks = await loader.load(999)
    expect(authorBooks).to.have.length(0)
  })
  it('should have cached authorId fetches', async () => {
    const cache = dataLoaderFactory.getFilteredcache(BOOKS_BY_AUTHOR_ID, { genre: 'mystery' })
    expect(cache).to.have.length(6)
  })
})
