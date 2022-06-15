/* eslint-disable @typescript-eslint/no-unused-expressions */
import { expect } from 'chai'
import { intersect } from 'txstate-utils'
import { BestMatchLoader, DataLoaderFactory } from '../src'
import { getData } from './common'

const booksByGenreHighestIdLoader = new BestMatchLoader({
  fetch: async (keys: string[]) => (await getData('books')).filter(b => intersect(b.genres, keys).length).map(b => { (b as any).genreSet = new Set(b.genres); return b }),
  scoreMatch: (key, book) => (book as any).genreSet.has(key) ? book.authorId * 100 + book.id : 0
})

describe('bestmatch loader', () => {
  const dlf = new DataLoaderFactory()

  it('should return exactly one book per genre', async () => {
    const book = await dlf.get(booksByGenreHighestIdLoader).load('fantasy')
    expect(book!.id).to.equal(1)
    const book2 = await dlf.get(booksByGenreHighestIdLoader).load('mystery')
    expect(book2!.id).to.equal(8)
    const book3 = await dlf.get(booksByGenreHighestIdLoader).load('war')
    expect(book3).to.be.undefined
  })

  it('should work with loadMany', async () => {
    const books = await dlf.loadMany(booksByGenreHighestIdLoader, ['fantasy', 'mystery', 'war'])
    const bookIds = books.map(b => b.id)
    expect(bookIds).to.deep.equal([1, 8])
  })
})
