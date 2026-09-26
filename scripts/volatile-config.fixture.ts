/** Shared volatile schema fixture for the schema and Loader volatile specs. */
import z from '@deepseek-ai/schemastery'

/** Mixed ordinary, volatile, nested and whole-object volatile fields. */
export const Config = z.object({
  fixed: z.string().default('fixed'),
  title: z.string().default('hello').volatile(),
  optional: z.string().volatile(),
  nested: z.object({ count: z.number().min(0).volatile().default(1) }).default({}),
  group: z.object({ list: z.array(z.string()) }).default({ list: [] }).volatile(),
})
