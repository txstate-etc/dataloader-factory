/* eslint-disable @typescript-eslint/no-unused-expressions */
import yaml from 'js-yaml'
import { promises as fsp } from 'fs'
import { DataLoaderFactory, ManyJoinedLoader, ManyToManyLoader, OneToManyLoader, PrimaryKeyLoader } from '../src/index'
import { expect } from 'chai'

interface Author {
  id: number
  name: string
}

interface Book {
  id: number
  authorId: number
  name: string
  genres: string[]
}

interface BookFilter {
  genre: string
}

async function getData (type: 'books'): Promise<Book[]>
async function getData (type: 'authors'): Promise<Author[]>
async function getData (type: string) {
  const ymlstring = await fsp.readFile(`test/data/${type}.yml`, 'utf-8')
  return yaml.load(ymlstring) as any[]
}

let byAuthorIdCount = 0
const booksByAuthorId = new OneToManyLoader({
  fetch: async (keys: number[], filters: BookFilter) => {
    byAuthorIdCount += 1
    const allbooks = await getData('books')
    return allbooks.filter(book => keys.includes(book.authorId) && book.genres.includes(filters.genre))
  },
  extractKey: (item) => item.authorId
})

const booksByAuthorIdAccessor = new OneToManyLoader({
  fetch: async (keys: number[]) => {
    const allbooks = await getData('books')
    return allbooks.filter(book => keys.includes(book.authorId))
  },
  extractKey: 'authorId'
})

const booksByAuthorIdMatchKey = new OneToManyLoader({
  fetch: async (keys: number[], filters: BookFilter) => {
    const allbooks = await getData('books')
    return allbooks.filter(book => keys.includes(book.authorId) && book.genres.includes(filters.genre))
  },
  matchKey: (key, item) => item.authorId === key
})

let byIdCount = 0
const booksById = new PrimaryKeyLoader({
  fetch: async (ids: number[]) => {
    byIdCount += 1
    const allbooks = await getData('books')
    return allbooks.filter(book => ids.includes(book.id))
  }
})

const booksByIdAccessor = new PrimaryKeyLoader({
  fetch: async (ids: number[]) => {
    const allbooks = await getData('books')
    return allbooks.filter(book => ids.includes(book.id))
  },
  extractId: 'id'
})

const booksByIdAndTitle = new PrimaryKeyLoader({
  fetch: async (compoundkeys: { id: number, name: string }[]) => {
    const allbooks = await getData('books')
    const ret = allbooks.filter(book =>
      compoundkeys.some(compoundkey =>
        book.id === compoundkey.id && book.name === compoundkey.name
      )
    )
    return ret
  },
  extractId: book => ({ id: book.id, name: book.name })
})

let customStringifyCount = 0
const booksByIdAndTitleCustomStringify = new PrimaryKeyLoader({
  fetch: async (compoundkeys: { id: number, name: string }[]) => {
    customStringifyCount += 1
    const allbooks = await getData('books')
    const ret = allbooks.filter(book =>
      compoundkeys.some(compoundkey =>
        book.id === compoundkey.id && book.name === compoundkey.name
      )
    )
    return ret
  },
  extractId: book => ({ id: book.id, name: book.name }),
  options: {
    cacheKeyFn: ({ id, name }: { id: number, name: string }) => `${id}.${name}`
  }
})

const booksByGenre = new ManyToManyLoader({
  fetch: async (genres: string[]) => {
    const allbooks = await getData('books')
    const books = allbooks.filter(book => book.genres.some((genre: string) => genres.includes(genre)))
    return books
  },
  extractKeys: book => book.genres,
  idLoader: booksById
})

const booksByGenreAccessor = new ManyToManyLoader({
  fetch: async (genres: string[]) => {
    const allbooks = await getData('books')
    const books = allbooks.filter(book => book.genres.some((genre: string) => genres.includes(genre)))
    return books
  },
  extractKeys: 'genres'
})

const booksByGenreMatchKey = new ManyToManyLoader({
  fetch: async (genres: string[]) => {
    const allbooks = await getData('books')
    const books = allbooks.filter(book => book.genres.some((genre: string) => genres.includes(genre)))
    return books
  },
  matchKey: (key, book) => book.genres.includes(key)
})

const booksByGenreJoined = new ManyJoinedLoader({
  fetch: async (genres: string[]) => {
    const allbooks = await getData('books')
    const books = allbooks.filter(book => book.genres.some((genre: string) => genres.includes(genre)))
    return books.flatMap(book => book.genres.map((g: any) => ({ key: g, value: book })))
  },
  idLoader: [booksById]
})

describe('bookloader', () => {
  const factory = new DataLoaderFactory()
  before(() => {
    byAuthorIdCount = 0
    byIdCount = 0
  })
  it('should be able to load books by authorId', async () => {
    const loader = factory.get(booksByAuthorId, { genre: 'mystery' })
    const authors = await getData('authors')
    const authorBooks = await Promise.all<any>(authors.map(async (a: any) => await loader.load(a.id)))
    expect(byAuthorIdCount).to.equal(1)
    expect(authorBooks).to.have.length(6)
    for (const books of authorBooks) {
      for (const book of books) {
        expect(book.genres).to.include('mystery')
      }
    }
  })
  it('should return an empty array for an unrecognized authorId', async () => {
    const authorBooks = await factory.get(booksByAuthorId).load(999)
    expect(byAuthorIdCount).to.equal(2)
    expect(authorBooks).to.have.length(0)
  })
  it('should use dataloader cache for subsequent loads', async () => {
    const books = await factory.get(booksByAuthorId, { genre: 'mystery' }).load(2)
    expect(books).to.have.length(1)
    expect(byAuthorIdCount).to.equal(2)
  })
  it('should have cached authorId fetches', async () => {
    const cache = factory.getCache(booksByAuthorId, { genre: 'mystery' })
    expect(cache).to.have.length(6)
  })
  it('should load books with the ID dataloader', async () => {
    const book = await factory.get(booksById).load(2)
    expect(book).to.exist
    expect(byIdCount).to.equal(1)
    expect(book!.id).to.equal(2)
  })
  it('should load multiple books with the ID dataloader and keep them in order', async () => {
    const twobooks = await Promise.all([4, 3].map(async id => await factory.get(booksById).load(id)))
    expect(byIdCount).to.equal(2)
    expect(twobooks).to.have.length(2)
    expect(twobooks[0]!.id).to.equal(4)
    expect(twobooks[1]!.id).to.equal(3)
  })
  it('should cache subsequent loads by ID', async () => {
    const book = await factory.get(booksById).load(3)
    expect(byIdCount).to.equal(2)
    expect(book!.id).to.equal(3)
  })

  it('should support compound keys', async () => {
    const book = await factory.get(booksByIdAndTitle).load({ id: 2, name: 'Bloody Bones' })
    expect(book!.id).to.equal(2)
    const nobook = await factory.get(booksByIdAndTitle).load({ id: 2, name: 'Tale of Two Cities' })
    expect(nobook).to.be.undefined
  })

  it('should support compound keys with custom cache key function', async () => {
    const book = await factory.get(booksByIdAndTitleCustomStringify).load({ id: 2, name: 'Bloody Bones' })
    expect(book!.id).to.equal(2)
    expect(customStringifyCount).to.equal(1)
    const samebook = await factory.get(booksByIdAndTitleCustomStringify).load({ id: 2, name: 'Bloody Bones' })
    expect(samebook!.id).to.equal(2)
    expect(customStringifyCount).to.equal(1)
    const anotherbook = await factory.get(booksByIdAndTitleCustomStringify).load({ id: 3, name: 'Tale of Two Cities' })
    expect(anotherbook!.id).to.equal(3)
    expect(customStringifyCount).to.equal(2)
  })

  it('should support many to many and prime the booksById cache', async () => {
    factory.get(booksById).clearAll()
    const books = await factory.get(booksByGenre).load('mystery')
    expect(books).to.have.length(2)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
    expect(factory.getCache(booksById)).to.have.lengthOf(2)
  })

  it('should work with the manyJoined pattern and prime the booksById cache', async () => {
    factory.get(booksById).clearAll()
    const books = await factory.get(booksByGenreJoined).load('mystery')
    expect(books).to.have.length(2)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
    expect(factory.getCache(booksById)).to.have.lengthOf(2)
  })
  it('should support matchKey in one-to-many pattern', async () => {
    const books = await factory.get(booksByAuthorIdMatchKey, { genre: 'mystery' }).load(2)
    expect(books).to.have.length(1)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
  })
  it('should support matchKey in many-to-many pattern', async () => {
    const books = await factory.get(booksByGenreMatchKey).load('mystery')
    expect(books).to.have.length(2)
    for (const book of books) {
      expect(book.genres.includes('mystery'))
    }
  })
  it('should be able to load many ids at once, ignoring undefineds', async () => {
    const books = await factory.loadMany(booksById, [1, 5, 6, 20])
    expect(books.length).to.equal(3)
  })
  it('should be able to load many from a *ToMany loader and flatten the results', async () => {
    const books = await factory.loadMany(booksByGenre, ['fantasy', 'holiday', 'nulltest'])
    expect(books.length).to.equal(4)
    for (const book of books) expect(book.genres.filter(g => ['fantasy', 'holiday'].includes(g))).to.not.be.empty
  })
  it('should be able to clear the loader cache and recover', async () => {
    factory.get(booksById).clearAll()
    byIdCount = 0
    const book = await factory.get(booksById).load(3)
    expect(byIdCount).to.equal(1)
    expect(book!.id).to.equal(3)
    factory.clear()
    const book2 = await factory.get(booksById).load(3)
    expect(byIdCount).to.equal(2)
    expect(book2!.id).to.equal(3)
  })
  it('should be able to use an accessor string in a PrimaryKeyLoader', async () => {
    const book = await factory.get(booksByIdAccessor).load(1)
    expect(book).to.not.be.undefined
  })
  it('should be able to use an accessor string in a OneToManyLoader', async () => {
    const books = await factory.get(booksByAuthorIdAccessor).load(1)
    expect(books.length).to.be.greaterThan(0)
  })
  it('should be able to use an accessor string in a ManyToManyLoader', async () => {
    const books = await factory.get(booksByGenreAccessor).load('fantasy')
    expect(books.length).to.equal(3)
  })
})
