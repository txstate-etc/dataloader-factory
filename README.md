# dataloader-factory
A Factory pattern designed to be used to implement GraphQL resolvers efficiently.

The basic concept of this library is that you will create a new factory instance per request and
stash it in the graphql request context. Then you can ask the factory any time you need a dataloader
instance, and it will either generate one or return one it already created.

In addition, it takes on the burden of putting results into the correct order for dataloader, by
having you specify an `extractId` or `extractKey` function to teach it where the id is in your data
object.

## Upgrading from 3.0

The 4.0 release is a major API revision that focuses on the typescript-safe API outlined in this
README. The old string-based `.register` and `.get` and `.getOneToMany` and etc are all gone. You'll
need to update your code to change over to the new API, but the configuration options have not changed
(except `matchKey` has been removed from the `ManyJoinedLoader` since it doesn't make sense).

```javascript
DataLoaderFactory.register('youruniquestring', { /* your config */ })
// inside your resolvers
  factory.get('youruniquestring').load(id)
```
should be replaced with
```javascript
const myLoader = new PrimaryKeyLoader({ /* your config */ })
// inside your resolvers
  factory.get(myLoader).load(id)
```
The transition is very similar for the array-returning types, except all the `.getOneToMany`,
`.getManyToMany`, etc, have been removed since `.get()` is simpler and can cover everything
in 4.0.

### If you were using typesafe classes already
If you were aready on the typesafe API, all you need to handle is that `factory.getMany` has
been replaced in all cases by `factory.get`.
```javascript
factory.getMany(myOneToManyLoader, args).load(id)
```
should be replaced with
```javascript
factory.get(myOneToManyLoader, args).load(id)
```

## Basic Usage (Load by Primary Key)
You can spread your `*Loader` configurations out into any file structure you like, just
create and export an instance of each type of loader, so you can import it in your resolvers.

```javascript
import { PrimaryKeyLoader } from 'dataloader-factory'
export const authorLoader = new PrimaryKeyLoader({
  fetch: async ids => {
    return db.query(`SELECT * FROM authors WHERE id IN (${ids.map(id => '?').join(',')})`, ids)
  },
  extractId: book => book.id
})
```
Then the factory should be added to context on each request, e.g.:
```javascript
import { DataLoaderFactory } from 'dataloader-factory'
new ApolloServer({
  context: req => {
    return { dataLoaderFactory: new DataLoaderFactory() }
  }
})
```
Then it may be used in resolvers:
```javascript
import { authorLoader } from './authorLoader.js' // or wherever you put it
export const bookAuthorResolver = (book, args, context) => {
  return context.dataLoaderFactory.get(authorLoader).load(book.authorId)
}
```
When you pass an instance of one of the `*Loader` classes to `dataLoaderFactory.get()`,
dataloader-factory will use the configuration information it contains to create and
cache instances of `DataLoader` for you, generating a brand new set of `DataLoader`s for
every new request.
### Options
The `PrimaryKeyLoader` constructor accepts the following input:
```typescript
const myLoader = new PrimaryKeyLoader<IdType, ObjectType>({
  // the core batch function for DataLoader, except DataLoaderFactory handles
  // putting it back together in order, so all you need to do is fetch
  // see below for discussion of context parameter
  fetch: (ids: IdType[], context) => ObjectType[],

  // a function for extracting the id from each item returned by fetch
  // if not specified, it guesses with this default function
  extractId: item => item.id || item._id,

  // specify one or more primary key loaders and they will automatically
  // be primed with any results gathered
  // NOTE: if the above fetch function returns result objects that differ from those of
  // the specified loader(s), it's going to cause you problems
  idLoader: PrimaryKeyLoader|PrimaryKeyLoader[],

  // the options object to pass to dataloader upon creation
  // see dataloader documentation for details
  options: DataLoader.Options
})
```
### Note about extractId
Let's take a moment to discuss the `extractId` configuration option as shown in the above
example. I find that it is a common sticking point for people first learning about building
graphql APIs with dataloader-factory.

If you've read the [documentation for dataloader](https://github.com/graphql/dataloader) (and
I hope you have!), you'll recall that the batch function you give to a dataloader is required
to return results in the exact same order as the keys that were provided, and the return array
should have undefined in it for any keys that didn't turn out to exist.

So if you get the array `[2, 1, 3]`, and 3 doesn't exist in your database, you must return
`[{ myKey: 2, ...moredata }, { myKey: 1, ...moredata }, undefined]`

The typical performant pattern for that is:
```typescript
const myKeyLoader = new DataLoader(async (keys) => {
  const rows = await lookupKeysInDatabase(keys)
  const rowsByKey = results.reduce((rowsByKey, row) => ({ ...rowsByKey, [row.myKey]: row }), {})
  return keys.map(k => rowsByKey[k])
})
```
I find that pattern to be quite repetitive and ugly, even if you replace the reduce with
`lodash.groupby` or the like. Furthermore, the one-to-many and many-to-many patterns are a
little more complicated to unwind. So dataloader-factory handles that part for you. Your `fetch`
function only has to return a set of rows, and they'll get properly sorted and formatted for
dataloader automatically.

The only thing I need from you to make that happen is a function that tells me which property
represents the key that we were batching on. That's why `extractId` (or `extractKey(s)` in the
other loader types) is part of the configuration. In the example above, we were batching on `myKey`
so the `extractId` function would be `row => row.myKey`.

You can also specify a string `extractId: 'myKey'` instead of a function and that'll work. Or
if your key is the highly typical `'id'` or `'_id'`, you don't even need to specify `extractId`
because I'll look for those anyway (in that order of preference).

### Pass-through Context
In the Options section above, you may have noticed that the `fetch` function receives a `context`
parameter. This is an extra option for you to be able to pass information from the request context
through to your `fetch` function, in case you have filters that are context-sensitive, like a dataloader
for fetching friendships of the current user or one that needs to fetch only records the current
user is authorized to read.

To set the pass-through `context`, pass it in when you construct a new `dataLoaderFactory` instance,
and then it will be passed to your fetch functions.
```javascript
new ApolloServer({
  context: req => {
    const userinfo = parseBearerToken(req.headers.authorization)
    return { dataLoaderFactory: new DataLoaderFactory(userinfo) }
  }
})
```

## One-to-Many DataLoaders
The `PrimaryKeyLoader` is only appropriate for primary key lookups (or another key that
identifies exactly one record). To fetch relations that return an array, a more complex pattern
is required.

The first of these patterns is the one-to-many pattern. Use it when you have a one to many
relationship you're trying to map, and your fetch function returns objects that will each map to
a single key value. For instance, a page always exists inside a single book, so the
`pagesByBookId` implementation might look like this:
```javascript
import { OneToManyLoader } from 'dataloader-factory'
const pagesByBookIdLoader = new OneToManyLoader({
  fetch: async bookids => {
    return db.query(
      `SELECT * FROM pages WHERE bookId IN (${bookids.map(id => '?').join(',')})`,
    bookids)
  },
  extractKey: page => page.bookId
})
```
The resolver might then look like this.
```javascript
export const bookPagesResolver = (book, args, context) => {
  return context.dataLoaderFactory.get(pagesByBookIdLoader, args).load(book.id)
}
```
Note that this is also useful for many-to-many relationships that have a named intermediary. For
instance, the relationship between a book and a library might be represented as an `Acquisition` that
links a book and a library and additionally lists a date the book was purchased.  In this case the
dataloader for `book -> acquisition` is one-to-many, the dataloader for `library -> acquisition` is
one-to-many, and for `book -> library` the developer has the option of chaining
`book -> acquisition -> library` or creating a new many-to-many dataloader that uses a database join
to save a round trip (see the "Many-to-Many-Joined" section below).

### Options
The `OneToManyLoader` constructor accepts the following inputs. All of the *-to-many patterns accept the
same options, except as specifically noted in their section of the documentation.
```typescript
const myOneToManyLoader = new OneToManyLoader<KeyType, ObjectType, FilterType>({
  // accept arbitrary foreign keys and arbitrary arguments and return results
  // the keys MUST appear in the result objects so that your
  // extractKey function can retrieve them
  // see PrimaryKeyLoader options for discussion of context parameter
  fetch: async (keys: KeyType[], filters: FilterType, context) => ObjectType[] // required

  // function that can pull the foreign key out of the result object
  // must match the type of the keys you're using in your fetch function
  extractKey: (item: ObjectType) => item.authorId // required

  // advanced usage only, covered later in this readme
  matchKey: (key: KeyType, item: ObjectType) => boolean

  // generated dataloaders will not keep a cache, batch only
  skipCache: false

  // maxBatchSize to be passed to each DataLoader
  maxBatchSize: 1000

  // cacheKeyFn to be passed to each DataLoader, default is fast-json-stable-stringify
  // which should be good for almost any case
  cacheKeyFn: (key: KeyType) => stringify(key)

  // specify one or more primary key loaders and they will automatically
  // be primed with any results gathered
  // NOTE: if the above fetch function returns result objects that differ from those of
  // the specified loader(s), it's going to cause you problems
  idLoader: PrimaryKeyLoader|PrimaryKeyLoader[],
})
```
Note that `KeyType` can be anything serializable, so you can use arrays or objects for any compound keys you may have.

## Many-to-Many DataLoaders
For DataLoaderFactory, the Many-to-Many pattern is split into two use-cases: one targeted at
document-oriented databases like MongoDB (this section), another for relational databases like MySQL or
Oracle (see the next section, "Many-to-Many-Joined").

In document-oriented databases a typical pattern for a simple many-to-many relationship is to store an
array of keys inside one of the documents. For instance, a book might be represented like this:
```javascript
{
  id: 1,
  title: 'Great American Novel',
  genreIds: [1,3,8]
}
```
The `Book.genres` resolver is trivial, you can use the primary key loader with your `genres` array.
However, `Genre.books` requires a special treatment from DataLoaderFactory that asks you for
`extractKeys` instead of `extractKey` (all other options are identical):
```javascript
import { ManyToManyLoader } from 'dataloader-factory'
const booksByGenreIdLoader = new ManyToManyLoader({
  fetch: async genreIds => {
    // this example is for mongodb client
    return db.collection('books').find({ genreIds: { $in: genreIds } }).toArray()
  },
  extractKeys: book => book.genreIds
})
```
and the resolver
```javascript
export const genreBooksResolver = (genre, args, context) => {
  return context.dataLoaderFactory.get(booksByGenreIdLoader).load(genre.id)
}
```
Note that it is also possible to use a named intermediary in document-oriented databases. Depending on
the database, you may still find the Many-to-Many-Joined pattern useful in those cases.

## Many-to-Many-Joined DataLoaders
It is technically possible to handle SQL many to many relationships with the OneToManyLoader, like this:
```javascript
import { OneToManyLoader } from 'dataloader-factory'
const booksByGenreIdLoader = new OneToManyLoader({
  fetch: async genreIds => {
    const books = await db.get(`
      SELECT b.*, bg.genre_id as genreId
      FROM books b
      INNER JOIN books_genres bg ON b.id = bg.book_id
      WHERE bg.genre_id IN (${genreIds.map(id => '?').join(',')})`)
    return books
  },
  extractKey: book => book.genreId
})
```
This will work but it means the book object being passed to the rest of your code has a `genreId`
property that doesn't really belong there. This is especially annoying when using Typescript as you need
to create a new interface like `BookWithGenreId` to represent this not-quite-a-book object.

Luckily DataLoaderFactory provides a cleaner pattern with `ManyJoinedLoader`:
```javascript
import { ManyJoinedLoader } from 'dataloader-factory'
const booksByGenreIdLoader = new ManyJoinedLoader({
  fetch: async genreIds => {
    const books = await db.get(`
      SELECT b.*, bg.genre_id as genreId
      FROM books b
      INNER JOIN books_genres bg ON b.id = bg.book_id
      WHERE bg.genre_id IN (${genreIds.map(id => '?').join(',')})`)
    return books.map(row => ({ key: row.genreId, value: new Book(row) }))
  }
})
```
You no longer provide an `extractKey` function because you return it with each row. DataLoaderFactory
will use the key you provide to put the data back together and then discard it, returning only the
pristine `Book` from the `value` field back to the `.load()` call in your resolver.

## Parameter-based filtering
Now we get to the part where this library can really save your bacon. Consider the following GraphQL
query:
```graphql
{ authors { books(genre: "mystery") { title } } }
```
Without `dataloader-factory`, the typical pattern for the authors.books dataloader looks like this:
```javascript
const booksByAuthorId = new DataLoader(async (authorIds) => {
  const books = await db.query(
    `SELECT * FROM books WHERE authorId IN (${authorIds.map(id => '?').join(',')})`
  , authorIds)
  const bookMap = lodash.groupBy(books, 'authorId')
  return authorIds.map(id => bookMap[id] || [])
})
```
Easy so far, but adding the `genre: "mystery"` filter is not obvious and can be very confusing to
implement. You can only batch on one key at a time, so how are you supposed to batch when you have
both an authorId and a genre to filter with?

Since `genre: "mystery"` is the argument, and `authors` is the array in this query, clearly we want
to batch on `authorId`. But if I call `.load(authorId)`, how am I going to pass the genre to the
batch function? I could try something like `.load({ authorId, genre })`, but transforming that into
SQL is going to be a nightmare as the number of filters gets larger.

The answer is actually to create a new DataLoader instance for each unique set of extra filtering
arguments. So in the genre case, we need a DataLoader for mysteries, another DataLoader for fantasy,
and so on.  Since we don't want to hard-code an exhaustive list of genres, we need a function that
can generate new DataLoaders, and since we don't want to use infinite RAM, it should do so on demand.
Well we're in luck, because that's exactly what dataloader-factory was built to do!

So using dataloader-factory, it becomes fairly simple; the resolver would look like this (ignore the
overly simplistic data model):
```javascript
import { OneToManyLoader } from 'dataloader-factory'
const booksByAuthorIdLoader = new OneToManyLoader({
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
  return context.dataLoaderFactory.get(booksByAuthorIdLoader, args).load(author.id)
}
```
Behind the scenes, what this does is generate a distinct DataLoader instance for each set of
args we encounter. Generating so many DataLoaders may seem like a problem, but remember -
graphql queries are always finite, so there can only be a few sets of arguments in any one request,
and each request gets a new factory. So the number of possible dataloaders generated per request is
manageable, and they all get garbage collected after the request.

## Advanced Usage Example
Many GraphQL data types will have more than one other type referencing them. In those
cases, it will probably be useful to create a single function that accepts a set of `filters`
and uses it to construct and execute a database query. Then each `fetch` function can simply
merge the batch of `keys` into the `filters` object, and pass the merged object to the
query function. This example should help illustrate:
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
const booksByAuthorIdLoader = new OneToManyLoader({
  fetch: (authorIds, filters) {
    return executeBookQuery({ ...filters, authorIds })
  },
  extractKey: item => item.authorId
})
const booksByGenreLoader = new OneToManyLoader({
  fetch: (genres, filters) => {
    return executeBookQuery({ ...filters, genres })
  },
  extractKey: item => item.genre
})
```
See how executeBookQuery is re-usable no matter how many different types of filtering we add? You don't
have to use this pattern but I find it very helpful.

## Compound Keys
Compound Keys are fully supported. Any key object will be accepted. It is up to your `fetch` and
`extractKey` functions to treat it properly. Internally, fast-json-stable-stringify is used to cache
results, which will construct the same string even if two objects' keys have mismatching ordering.

## matchKey
In rare cases it may be that you are unable to provide an `extractKey` function because a key
cannot be extracted from an item because an irreversible operation is involved (like evaluating
greater than or less than)

In those cases, you can provide a `matchKey` function that examines whether the result object is
a match for the given key. The answer will help us put the fetched dataset back together properly.

Please note that this makes the batched load an O(n^2) operation so `extractKey` is
preferred whenever possible. If you use `matchKey`, the `maxBatchSize` default will change to 50
to help limit scaling problems.
```javascript
const booksAfterYearLoader = new OneToManyLoader({
  fetch: (years, filters) => {
    const ors = years.map(parseInt).map(year => `published > DATE('${year}0101')`)
    return db.query(`SELECT * FROM books WHERE ${ors.join(') OR (')}`
  },
  matchKey: (year, book) => book.published.getTime() >= new Date(year, 0, 1)
  maxBatchSize: 20
})
```

## loadMany
Dataloader has a `.loadMany` method that can be used to retrieve objects based on an
array of keys. However, it is designed to return Errors for any keys that threw an error, so
you have to be aware of that any time you use it. Additionally, keys that do not point at any
data will come back undefined, and you will have undefined values in the returned array.

To avoid both of these problems and just get an array of any of the objects that exist, a
`.loadMany` method exists on the factory for your convenience:
```javascript
const books = await ctx.loaders.loadMany(bookLoader, bookIds)
```
It also works for *ToMany loaders and flattens the results (this would return an array
of books written by any of the specified authors):
```javascript
const books = await ctx.loaders.loadMany(booksByAuthorLoader, authorIds, filters)
```

## Mutations
In graphql, after a mutation there will be a query, which can be very complex. If this query
is evaluated after you have already done some dataloading (e.g. to find related objects to help
authorize the mutation), you will want to get rid of any cached objects that were fetched before
the mutationcompleted. Creating a new DataLoaderFactory instance is one way, but probably
cumbersome. Instead of replacing your instance, you can call `.clear()` on your instance and all
your existing dataloaders will be tossed so that your post-mutation query can run against fresh
data.

## TypeScript
This library is written in typescript and provides its own types. When you create a new loader type,
you can choose whether to provide your types as generics, which will help you write your `fetch`
function properly, or you can write your `fetch` function and its input/return types will be used
implicitly for everything else.
```typescript
import { PrimaryKeyLoader } from 'dataloader-factory'
const bookLoader = new PrimaryKeyLoader({
  fetch: async (ids: string[]) => { // provide the key type either here or as a generic
    ... // return type will infer based on what you return here, or you can set it as a generic
  },
  extractId: (item) => { // typescript should know you'll receive IBook
    ... // typescript should know you need to return string
  }
})

export const bookResolver = async (book, args, context) => {
  // typescript should know load() accepts a string
  // and that bookResolver will return Promise<YourBookType>
  return await context.dataLoaderFactory.get(bookLoader).load(book.authorId)
}
```
The *ToMany classes work the same way, with a third generic for FilterType:
```typescript
const booksByAuthorIdLoader = new OneToManyLoader({
  fetch: (authorIds: string[], filters: BookFilters) {
    return executeBookQuery({ ...filters, authorIds })
  },
  extractKey: item => item.authorId
})
export const authorBooksResolver = (author, args, context) => {
  // this next line is type-safe: args and author.id will both be checked and load will return
  // Promise<YourBookType>
  return context.dataLoaderFactory.get(authorBooksLoader, args).load(author.id)
}
```
