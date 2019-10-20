# dataloader-factory
DataLoader classes to make it easier to write complex graphql resolvers.

## Filtered DataLoaders
Consider the following GraphQL query:
```
{ authors { books(genre: "mystery") { title } } }
```
The typical pattern for the authors.books dataloader looks like this:
```
const booksByAuthorId = new DataLoader(async (authorIds) => {
  const books = await db.query(
    `SELECT * FROM books WHERE authorId IN (${authorIds.map('?').join(',')})`
  , authorIds)
  const bookMap = lodash.groupBy(books, 'authorId')
  return authorIds.map(id => bookMap[id] || [])
})
```
But adding the `genre: "mystery"` filter is not obvious and can be very confusing to implement.

That's where this library can help. The resolver would look like this
(ignore the overly simplistic data model for genre):
```
import { DataLoaderFactory } from 'dataloader-factory'
DataLoaderFactory.registerFiltered('booksByAuthorId', {
  fetch: (authorIds, filters) => {
    return db.query(
      `SELECT * FROM books WHERE authorId IN (${authorIds.map('?').join(',')}) AND genre=?`
    , [...authorIds, filters.genre])
  },
  extractId: book => book.authorId
})
export const authorBooksResolver = (author, args, context) => {
  return context.dataLoaderFactory.getFiltered('booksByAuthorId', args).load(author.id)
}
```
