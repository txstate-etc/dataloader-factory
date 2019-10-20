import yaml from 'js-yaml'
import { promises as fsp } from 'fs'
import { DataLoaderFactory } from '../src/index'
import { expect } from 'chai'

async function getData (type:string):Promise<any[]> {
  const ymlstring = await fsp.readFile(`test/data/${type}.yml`, 'utf-8')
  return yaml.safeLoad(ymlstring)
}

let byAuthorIdCount = 0
const BOOKS_BY_AUTHOR_ID = 'booksByAuthorId'
DataLoaderFactory.registerFiltered(BOOKS_BY_AUTHOR_ID, {
  fetch: async (keys, filters) => {
    byAuthorIdCount += 1
    const allbooks = await getData('books')
    return allbooks.filter(book => keys.includes(book.authorId) && book.genres.includes(filters.genre))
  },
  extractKey: (item) => item.authorId
})

let byIdCount = 0
const BOOKS_BY_ID = 'books'
DataLoaderFactory.register(BOOKS_BY_ID, {
  fetch: async ids => {
    byIdCount += 1
    const allbooks = await getData('books')
    return allbooks.filter(book => ids.includes(book.id))
  }
})

describe('bookloader', () => {
  const dataLoaderFactory = new DataLoaderFactory()
  before (() => {
    byAuthorIdCount = 0
    byIdCount = 0
  })
  it('should be able to load books by authorId', async () => {
    const loader = dataLoaderFactory.getFiltered(BOOKS_BY_AUTHOR_ID, { genre: 'mystery' })
    const authoryml = await fsp.readFile('test/data/authors.yml', 'utf-8')
    const authors = yaml.safeLoad(authoryml)
    const authorBooks = await loader.loadMany(authors.map((a:any) => a.id))
    expect(byAuthorIdCount).to.equal(1)
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
    expect(byAuthorIdCount).to.equal(2)
    expect(authorBooks).to.have.length(0)
  })
  it('should use dataloader cache for subsequent loads', async () => {
    const books = await dataLoaderFactory.getFiltered(BOOKS_BY_AUTHOR_ID, { genre: 'mystery' }).load(2)
    expect(books).to.have.length(1)
    expect(byAuthorIdCount).to.equal(2)
  })
  it('should have cached authorId fetches', async () => {
    const cache = dataLoaderFactory.getFilteredcache(BOOKS_BY_AUTHOR_ID, { genre: 'mystery' })
    expect(cache).to.have.length(6)
  })
  it('should load books with the ID dataloader', async () => {
    const book = await dataLoaderFactory.get(BOOKS_BY_ID).load(2)
    expect(byIdCount).to.equal(1)
    expect(book.id).to.equal(2)
  })
  it('should load multiple books with the ID dataloader and keep them in order', async () => {
    const twobooks = await Promise.all([4,3].map(id => dataLoaderFactory.get(BOOKS_BY_ID).load(id)))
    expect(byIdCount).to.equal(2)
    expect(twobooks).to.have.length(2)
    expect(twobooks[0].id).to.equal(4)
    expect(twobooks[1].id).to.equal(3)
  })
  it('should cache subsequent loads by ID', async () => {
    const book = await dataLoaderFactory.get(BOOKS_BY_ID).load(3)
    expect(byIdCount).to.equal(2)
    expect(book.id).to.equal(3)
  })
})
