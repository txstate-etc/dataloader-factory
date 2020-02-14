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
DataLoaderFactory.registerOneToMany(BOOKS_BY_AUTHOR_ID, {
  fetch: async (keys, filters) => {
    byAuthorIdCount += 1
    const allbooks = await getData('books')
    return allbooks.filter(book => keys.includes(book.authorId) && book.genres.includes(filters.genre))
  },
  extractKey: (item) => item.authorId
})
const BOOKS_BY_AUTHOR_ID_MATCHKEY = 'booksByAuthorIdMatchKey'
DataLoaderFactory.registerOneToMany(BOOKS_BY_AUTHOR_ID_MATCHKEY, {
  fetch: async (keys, filters) => {
    const allbooks = await getData('books')
    return allbooks.filter(book => keys.includes(book.authorId) && book.genres.includes(filters.genre))
  },
  matchKey: (key, item) => item.authorId === key
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

const BOOKS_BY_ID_AND_TITLE = 'booksByIdAndTitle'
DataLoaderFactory.register(BOOKS_BY_ID_AND_TITLE, {
  fetch: async (compoundkeys) => {
    const allbooks = await getData('books')
    const ret = allbooks.filter(book =>
      compoundkeys.some(compoundkey =>
        Object.keys(compoundkey).every(field => book[field] === compoundkey[field])
      )
    )
    return ret
  },
  extractId: book => ({ id: book.id, name: book.name })
})

const BOOKS_BY_GENRE = 'booksByGenre'
DataLoaderFactory.registerManyToMany(BOOKS_BY_GENRE, {
  fetch: async genres => {
    const allbooks = await getData('books')
    const books = allbooks.filter(book => book.genres.some((genre:string) => genres.includes(genre)))
    return books
  },
  extractKeys: book => book.genres
})
const BOOKS_BY_GENRE_MATCHKEY = 'booksByGenreMatchKey'
DataLoaderFactory.registerManyToMany(BOOKS_BY_GENRE_MATCHKEY, {
  fetch: async genres => {
    const allbooks = await getData('books')
    const books = allbooks.filter(book => book.genres.some((genre:string) => genres.includes(genre)))
    return books
  },
  matchKey: (key, book) => book.genres.includes(key)
})

const BOOKS_BY_GENRE_JOINED = 'booksByGenreJoined'
DataLoaderFactory.registerManyJoined(BOOKS_BY_GENRE_JOINED, {
  fetch: async genres => {
    const allbooks = await getData('books')
    const books = allbooks.filter(book => book.genres.some((genre:string) => genres.includes(genre)))
    // using [].concat because vscode/typescript was having fits about using .flat()
    return [].concat(...books.map(book => book.genres.map((g:any) => ({ key: g, value: book }))))
  }
})
const BOOKS_BY_GENRE_JOINED_MATCHKEY = 'booksByGenreJoinedMatchKey'
DataLoaderFactory.registerManyJoined(BOOKS_BY_GENRE_JOINED_MATCHKEY, {
  fetch: async genres => {
    const allbooks = await getData('books')
    const books = allbooks.filter(book => book.genres.some((genre:string) => genres.includes(genre)))
    // using [].concat because vscode/typescript was having fits about using .flat()
    return [].concat(...books.map(book => book.genres.map((g:any) => ({ key: g, value: book }))))
  },
  matchKey: (key, book) => book.genres.includes(key)
})

describe('bookloader', () => {
  const dataLoaderFactory = new DataLoaderFactory()
  before (() => {
    byAuthorIdCount = 0
    byIdCount = 0
  })
  it('should be able to load books by authorId', async () => {
    const loader = dataLoaderFactory.getOneToMany(BOOKS_BY_AUTHOR_ID, { genre: 'mystery' })
    const authoryml = await fsp.readFile('test/data/authors.yml', 'utf-8')
    const authors = yaml.safeLoad(authoryml)
    const authorBooks = await Promise.all<any>(authors.map((a:any) => loader.load(a.id)))
    expect(byAuthorIdCount).to.equal(1)
    expect(authorBooks).to.have.length(6)
    for (const books of authorBooks) {
      for (const book of books) {
        expect(book.genres).to.include('mystery')
      }
    }
  })
  it('should return an empty array for an unrecognized authorId', async () => {
    const loader = dataLoaderFactory.getOneToMany(BOOKS_BY_AUTHOR_ID)
    const authorBooks = await loader.load(999)
    expect(byAuthorIdCount).to.equal(2)
    expect(authorBooks).to.have.length(0)
  })
  it('should use dataloader cache for subsequent loads', async () => {
    const books = await dataLoaderFactory.getOneToMany(BOOKS_BY_AUTHOR_ID, { genre: 'mystery' }).load(2)
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

  it('should support compound keys', async () => {
    const book = await dataLoaderFactory.get(BOOKS_BY_ID_AND_TITLE).load({ id: 2, name: 'Bloody Bones' })
    expect(book.id).to.equal(2)
  })

  it('should support many to many, i.e. extractKey returns an array', async () => {
    const books = await dataLoaderFactory.getOneToMany(BOOKS_BY_GENRE).load('mystery')
    expect(books).to.have.length(2)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
  })

  it('should work with the manyJoined pattern', async () => {
    const books = await dataLoaderFactory.getManyJoined(BOOKS_BY_GENRE_JOINED).load('mystery')
    expect(books).to.have.length(2)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
  })
  it('should support matchKey in one-to-many pattern', async () => {
    const books = await dataLoaderFactory.getOneToMany(BOOKS_BY_AUTHOR_ID_MATCHKEY, { genre: 'mystery' }).load(2)
    expect(books).to.have.length(1)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
  })
  it('should support matchKey in many-to-many pattern', async () => {
    const books = await dataLoaderFactory.getManyToMany(BOOKS_BY_GENRE_MATCHKEY).load('mystery')
    expect(books).to.have.length(2)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
  })
  it('should support matchKey in many-to-many-joined pattern', async () => {
    const books = await dataLoaderFactory.getManyJoined(BOOKS_BY_GENRE_JOINED_MATCHKEY).load('mystery')
    expect(books).to.have.length(2)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
  })
})
