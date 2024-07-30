import { expect } from 'chai'
import { DataLoaderFactory, ParentDocumentLoader } from '../src'
import { getData } from './common'

const bookByPageLoader = new ParentDocumentLoader({
  fetch: async (pageIds: number[]) => (await getData('books')).filter(b => {
    const pageIdSet = new Set(pageIds)
    return b.pages?.some(p => pageIdSet.has(p.id))
  }),
  childIds: book => book.pages?.map(p => p.id) ?? []
})

describe('parentdoc loader', () => {
  const dlf = new DataLoaderFactory()
  it('should return exactly one parent document', async () => {
    const book = await dlf.get(bookByPageLoader).load(4)
    expect(book!.id).to.equal(9)
    const book2 = await dlf.get(bookByPageLoader).load(1)
    expect(book2!.id).to.equal(8)
  })
  it('should not return duplicates with loadMany', async () => {
    const books = await dlf.loadMany(bookByPageLoader, [1, 2, 3])
    expect(books.length).to.equal(1)
    expect(books[0].id).to.equal(8)
  })
  it('properly filters out undefined during loadMany', async () => {
    const books = await dlf.loadMany(bookByPageLoader, [1, 999])
    expect(books).to.not.include(undefined)
  })
})
