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
    return db.query(`SELECT * FROM authors WHERE id IN (${ids.map(id => '?').join(',')})`, ids)
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
### Options
`register` accepts more input:
```javascript
{
  fetch: ids => []
  // a function for extracting the id from each item returned by fetch
  // if not specified, it guesses with this default function
  extractId: item => item.id || item._id
  // the options object to pass to dataloader upon creation
  // see dataloader documentation for details
  options: DataLoader.Options
}
```

## Filtered DataLoaders
Consider the following GraphQL query:
```graphql
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
    const params = [...authorIds]
    if (filters.genre) {
      query += ' AND genre=?'
      params.push(filters.genre)
    }
    return db.query(query, params)
  },
  extractKey: book => book.authorId
})
export const authorBooksResolver = (author, args, context) => {
  return context.dataLoaderFactory.getFiltered('booksByAuthorId', args).load(author.id)
}
```
Behind the scenes, what this does is generate a distinct DataLoader for each set of args used on that resolver. Since a graphql query is always finite, and each request gets a new factory, the number of possible DataLoaders generated is finite and manageable as well.

### Options
`registerFiltered` accepts the following inputs:
```typescript
{
  // accept arbitrary foreign keys and arbitrary arguments and return results
  // the keys MUST appear in the result objects so that your
  // extractKey function can retrieve them
  fetch: async (keys, filters) => [] // required
  // function that can pull the foreign key out of the result object
  // must match the interface of the keys you're using in your fetch function
  extractKey: item => item.authorId // required
  // generated dataloaders will not keep a cache
  skipCache: false
  // maxBatchSize to be passed to each DataLoader
  maxBatchSize: 1000
  // cacheKeyFn to be passed to each DataLoader
  cacheKeyFn: key => stringify(key)
  // each call to DataLoader.load() should return one row instead of
  // an array of rows
  returnOne: false
  // set idLoaderKey to the registered name of an ID Loader to automatically
  // prime it with any results gathered
  idLoaderKey: 'books'
  // if you provide an idLoaderKey, you may need to specify how to extract the
  // id from each returned item
  extractId item => item.id || item._id
}
```

## Advanced Usage
Many GraphQL data types will have more than one other type referencing them. In those
cases, it will probably be useful to create a single function for constructing and
executing the query, and each `fetch` function will simply add the batched `keys` to
the `filters` object, and then pass the merged `filters` to the single function.
```javascript
const executeBookQuery = filters => {
  const where = []
  const params = []
  if (filters.ids) {
    where.push(`id IN (${filters.ids.map(id => '?').join(',')})`)
    params.push(...filters.ids)
  }
  if (filters.authorIds) {
    where.push(`authorId IN (${filters.authorIds.map(id => '?').join(',')})`)
    params.push(...filters.authorIds)
  }
  if (filters.genres) {
    where.push(`genres IN (${filters.genres.map(id => '?').join(',')})`)
    params.push(...filters.genres)
  }
  const wherestr = where.length && `WHERE (${where.join(') AND (')})`
  return db.query(`SELECT * FROM books ${wherestr}`, params)
}
DataLoaderFactory.registerFiltered('booksByAuthorId', {
  fetch: (authorIds, filters) {
    return executeBookQuery({ ...filters, authorIds })
  },
  extractKey: item => item.authorId
})
DataLoaderFactory.registerFiltered('booksByGenre', {
  fetch: (genres, filters) {
    return executeBookQuery({ ...filters, genres })
  },
  extractKey: item => item.genre
})
```
