# dataloader-factory
A Factory pattern designed to be used to implement GraphQL resolvers efficiently.

Accepts configuration objects that require a `fetch` function. The fetch function contains
all the logic for constructing and executing a query against your database. The Factory will
take care of caching the DataLoaders and also helps with putting the results back into the correct
order, since that is usually required to make DataLoader work.

## Basic Usage (Load by Primary Key)
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
`register` accepts the following input:
```javascript
{
  // the core batch function for DataLoader, DataLoaderFactory handles
  // putting it back together in order
  // 'context' is available in case you need any authorization information
  // when accessing the database, this should be immutable for the entire
  // duration of a graphql request, not different per resolver
  fetch: (ids, context) => []
  // a function for extracting the id from each item returned by fetch
  // if not specified, it guesses with this default function
  extractId: item => item.id || item._id
  // the options object to pass to dataloader upon creation
  // see dataloader documentation for details
  options: DataLoader.Options
}
```
To set the pass-through `context` mentioned above, pass it in when you construct each new `dataLoaderFactory`.
```javascript
new ApolloServer({
  context: req => {
    const userinfo = parseBearerToken(req.headers.authorization)
    return { dataLoaderFactory: new DataLoaderFactory(userinfo) }
  }
})
```

## One-to-Many DataLoaders
The `register` and `get` methods are only appropriate for primary key loaders (or another key that
identifies exactly one record). To fetch relations that return an array, a more complex pattern is required.

The first of these patterns is the one-to-many pattern. Use it when your fetch function will return objects
that can be mapped back to a single key value. For instance, a page always exists inside a single book, so the
`pagesByBookId` dataloader might look like this:

```javascript
import { DataLoaderFactory } from 'dataloader-factory'
DataLoaderFactory.registerOneToMany('pagesByBookId', {
  fetch: async bookids => {
    return db.query(`SELECT * FROM pages WHERE bookId IN (${bookids.map(id => '?').join(',')})`, bookids)
  },
  extractKey: page => page.bookId
})
```
The resolver might then look like this:
```javascript
export const bookPagesResolver = (book, args, context) => {
  return context.dataLoaderFactory.getOneToMany('pagesByBookId', args).load(book.id)
}
```
Note that this is also useful for many-to-many relationships that have a named intermediary. For instance,
the relationship between a book and a library might be represented as an `Acquisition` that links a book and a
library and additionally lists a date the book was purchased.  In this case the dataloader for `book -> acquisition` is
one-to-many, the dataloader for `library -> acquisition` is one-to-many, and for `book -> library` the developer has the
option of chaining `book -> acquisition -> library` or creating a new many-to-many dataloader that uses a database join
for efficiency (see the "Many-to-Many-Joined" section below).

### Options
`registerOneToMany` accepts the following inputs. All of the *-to-many patterns accept the same options, except as
noted in their section of the documentation.
```javascript
{
  // accept arbitrary foreign keys and arbitrary arguments and return results
  // the keys MUST appear in the result objects so that your
  // extractKey function can retrieve them
  fetch: async (keys, filters, context) => [] // required

  // function that can pull the foreign key out of the result object
  // must match the interface of the keys you're using in your fetch function
  extractKey: item => item.authorId // required

  // advanced usage only, covered later in this readme
  matchKey: (key, item) => boolean

  // generated dataloaders will not keep a cache
  skipCache: false

  // maxBatchSize to be passed to each DataLoader
  maxBatchSize: 1000

  // cacheKeyFn to be passed to each DataLoader, default is fast-json-stable-stringify
  // which should be good for almost any case
  cacheKeyFn: key => stringify(key)

  // set idLoaderKey to the registered name of an ID Loader to automatically
  // prime it with any results gathered
  // NOTE: if your fetch function returns result objects that differ from those of
  // your ID Loader, it's going to cause you problems
  idLoaderKey: 'books'
}
```

## Many-to-Many DataLoaders
For DataLoaderFactory, Many-to-Many is split into two use-cases: one targeted at document-oriented databases like MongoDB (this section),
another for relational databases like MySQL or Oracle (see the next section, "Many-to-Many-Joined").

In document-oriented databases a typical pattern for a simple many-to-many relationship is to store an array of keys
inside one of the documents. For instance, a book might be represented like this:
```javascript
{
  id: 1,
  title: 'Great American Novel',
  genreIds: [1,3,8]
}
```
The `Book.genres` resolver is trivial, you can use the primary key loader for `genres`. However, `Genre.books`
requires a special treatment from DataLoaderFactory that asks you for `extractKeys` instead of `extractKey`
(all other options are identical):
```javascript
import { DataLoaderFactory } from 'dataloader-factory'
DataLoaderFactory.registerManyToMany('booksByGenreId', {
  fetch: async genreIds => {
    return db.collection('books').find({ genreIds: { $in: genreIds } }).toArray() // mongodb client syntax
  },
  extractKeys: book => book.genreIds
})
```
and the resolver
```javascript
export const genreBooksResolver = (genre, args, context) => {
  return context.dataLoaderFactory.getManyToMany('booksByGenreId').load(genre.id)
}
```
Note that it is also possible to use a named intermediary in document-oriented databases. Depending on the database,
you may still find the Many-to-Many-Joined pattern useful in those cases.

## Many-to-Many-Joined DataLoaders
It is possible to handle many to many relationships with the oneToMany pattern, like this:
```javascript
import { DataLoaderFactory } from 'dataloader-factory'
DataLoaderFactory.registerOneToMany('booksByGenreId', {
  fetch: async genreIds => {
    const books = await db.get(`
      SELECT b.*, g.id as genreId
      FROM books b
      INNER JOIN books_genres bg ON b.id = bg.book_id
      INNER JOIN genres g ON g.id = bg.genre_id
      WHERE g.id IN (${genreIds.map(id => '?').join(',')})`)
    return books
  },
  extractKey: book => book.genreId
})
```
This will work but it means the `Book` object being passed to the rest of your code has a `genreId` property that doesn't
really belong there. This is especially annoying when using Typescript as you need to create a new interface like `BookWithGenreId`
to represent this not-quite-a-book object.

Luckily DataLoaderFactory provides a cleaner pattern with `registerManyJoined` and `getManyJoined`:
```javascript
import { DataLoaderFactory } from 'dataloader-factory'
DataLoaderFactory.registerManyJoined('booksByGenreId', {
  fetch: async genreIds => {
    const books = await db.get(`
      SELECT b.*, g.id as genreId
      FROM books b
      INNER JOIN books_genres bg ON b.id = bg.book_id
      INNER JOIN genres g ON g.id = bg.genre_id
      WHERE g.id IN (${genreIds.map(id => '?').join(',')})`)
    return books.map(row => ({ key: row.genreId, value: new Book(row) }))
  }
})
```
You no longer provide an `extractKey` function because you return it with each row. DataLoaderFactory
will use the key you provide to put the data back together and then discard it, returning only the pristine
`Book` from the `value` field back to the `.load()` call in your resolver.

## Parameter-based filtering
Consider the following GraphQL query:
```graphql
{ authors { books(genre: "mystery") { title } } }
```
Without dataloader-factory, the typical pattern for the authors.books dataloader looks like this:
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

That's where this library really shines. Using dataloader-factory, the resolver would look like this
(ignore the overly simplistic data model):
```javascript
import { DataLoaderFactory } from 'dataloader-factory'
DataLoaderFactory.registerOneToMany('booksByAuthorId', {
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
  return context.dataLoaderFactory.getOneToMany('booksByAuthorId', args).load(author.id)
}
```
Behind the scenes, what this does is generate a distinct DataLoader for each set of args used on that resolver. Since a graphql query is always finite, and each request gets a new factory, the number of possible DataLoaders generated is finite and manageable as well.

## Advanced Usage Example
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
DataLoaderFactory.registerOneToMany('booksByAuthorId', {
  fetch: (authorIds, filters) {
    return executeBookQuery({ ...filters, authorIds })
  },
  extractKey: item => item.authorId
})
DataLoaderFactory.registerOneToMany('booksByGenre', {
  fetch: (genres, filters) => {
    return executeBookQuery({ ...filters, genres })
  },
  extractKey: item => item.genre
})
```

## Compound Keys
Compound Keys are fully supported. Any key object will be accepted. It is up to your `fetch` and `extractKey` functions
to treat it properly. Internally, fast-json-stable-stringify is used to cache results, which will construct the same string
even if two objects' keys have mismatching ordering.

## matchKey
In rare cases it may be that a key cannot be extracted from an item because
an irreversible operation is involved (like evaluating greater than or less than)

In those cases, you can provide a `matchKey` function that examines
whether the result object is a match for the given key. The answer
will help us put the fetched dataset back together properly.

Please note that this makes the batched load an O(n^2) operation so `extractKey` is
preferred whenever possible and a smaller `maxBatchSize` would be wise.
```javascript
DataLoaderFactory.registerOneToMany('booksAfterYear', {
  fetch: (years, filters) => {
    const ors = years.map(parseInt).map(year => `published > DATE('${year}0101')`)
    return db.query(`SELECT * FROM books WHERE ${ors.join(') OR (')}`
  },
  matchKey: (year, book) => book.published.getTime() >= new Date(year, 0, 1)
  maxBatchSize: 20
})
```

## TypeScript
This library is written in typescript and provides its own types. When you use the `register` and `get` methods (or the filtered versions), you may specify the KeyType and ReturnType as generics.
```javascript
DataLoaderFactory.register<string, IBook>('books', {
  fetch: (ids) => { // typescript should know you'll receive string[]
    ... // typescript should know you need to return IBook[]
  },
  extractId: (item) => { // typescript should know you'll receive IBook
    ... // typescript should know you need to return string
  }
})
```
```javascript
// typescript now knows .get() returns a DataLoader<string, IBook> so your .load()
// will return an IBook
dataLoaderFactory.get<string, IBook>('books').load(id)
```
