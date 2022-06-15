import yaml from 'js-yaml'
import { promises as fsp } from 'fs'

export interface Author {
  id: number
  name: string
}

export interface Book {
  id: number
  authorId: number
  name: string
  genres: string[]
}

export interface BookFilter {
  genre: string
  authorIds?: number[]
}

export async function getData (type: 'books'): Promise<Book[]>
export async function getData (type: 'authors'): Promise<Author[]>
export async function getData (type: string) {
  const ymlstring = await fsp.readFile(`test/data/${type}.yml`, 'utf-8')
  return yaml.load(ymlstring) as any[]
}
