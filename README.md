# dataloader-factory
A Factory pattern designed to be used to implement GraphQL resolvers efficiently.

Accepts configuration objects that require a `fetch` function. The fetch function contains
all the logic for constructing and executing a query against your database. The Factory will
take care of caching the DataLoaders and also helps with putting the results back into the correct
order, since that is usually required to make DataLoader work.

## Basic Usage
Fetching logic must be registered with the factory class at load time (register is a static method):
```javascript
import { DataLoaderFactory } from 'dataloader-factory'
DataLoaderFactory.register('authors', {
  fetch: async ids => {
    return db.query(`SELECT * FROM authors WHERE id IN (${ids.map(id => '?').join(',')})`)
  }
})
```
Then the factory should be added to resolver context on each request, e.g.:
```javascript
new ApolloServer({
  context: req => {
    return { dataLoaderFactory: new DataLoaderFactory() }
  }
})
```
Then it may be used in resolvers:
```javascript
export const bookAuthorResolver = (book, args, context) => {
  return context.dataLoaderFactory.get('authors').load(book.authorId)
}
```

## Filtered DataLoaders
Consider the following GraphQL query:
```javascript
{ authors { books(genre: "mystery") { title } } }
```
The typical pattern for the authors.books dataloader looks like this:
```javascript
const booksByAuthorId = new DataLoader(async (authorIds) => {
  const books = await db.query(
    `SELECT * FROM books WHERE authorId IN (${authorIds.map(id => '?').join(',')})`
  , authorIds)
  const bookMap = lodash.groupBy(books, 'authorId')
  return authorIds.map(id => bookMap[id] || [])
})
```
But adding the `genre: "mystery"` filter is not obvious and can be very confusing to implement.

That's where this library really shines. The resolver would look like this
(ignore the overly simplistic data model for genre):
```javascript
import { DataLoaderFactory } from 'dataloader-factory'
DataLoaderFactory.registerFiltered('booksByAuthorId', {
  fetch: (authorIds, filters) => {
    const query = `SELECT * FROM books WHERE authorId IN (${authorIds.map('?').join(',')})`
    const params = authorIds
    if (filters.genre) {
      query += ' AND genre=?'
      params.push(filters.genre)
    }
    return db.query(query, params)
  },
  extractId: book => book.authorId
})
export const authorBooksResolver = (author, args, context) => {
  return context.dataLoaderFactory.getFiltered('booksByAuthorId', args).load(author.id)
}
```
Behind the scenes, what this does is generate a distinct DataLoader for each set of args used on that resolver. Since a graphql query is always finite, and each request gets a new factory, the number of possible DataLoaders generated is finite and manageable as well.
