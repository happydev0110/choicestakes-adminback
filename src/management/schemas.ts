import { z } from "zod";
export const categories = [
  "featured",
  "new-games",
  "slots",
  "live",
  "crash-instant",
  "table-cards",
  "lotto-scratch",
  "roulette",
  "poker",
] as const;
export const categoryList = z
  .array(z.enum(categories))
  .max(categories.length)
  .refine((v) => new Set(v).size === v.length);
const page = z.coerce.number().int().min(1).max(100000).default(1);
const search = z.string().trim().max(100).default("");
export const playerFilters = z
  .object({
    page,
    search,
    status: z.enum(["", "active", "suspended"]).default(""),
  })
  .strict();
export const gameFilters = z
  .object({
    page,
    search,
    provider: z.string().max(128).default(""),
    category: z.union([z.literal(""), z.enum(categories)]).default(""),
    availability: z.enum(["", "available", "unavailable"]).default(""),
    visibility: z.enum(["", "visible", "hidden"]).default(""),
  })
  .strict();
export const playerUpdate = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(2)
      .max(30)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    status: z.enum(["active", "suspended"]),
    expected: z
      .object({ displayName: z.string().max(30), status: z.string().max(16) })
      .strict(),
  })
  .strict();
export const gameUpdate = z
  .object({
    visible: z.boolean(),
    categories: categoryList,
    expected: z
      .object({ visible: z.boolean(), categories: categoryList })
      .strict(),
  })
  .strict();
export type PlayerFilters = z.infer<typeof playerFilters>;
export type GameFilters = z.infer<typeof gameFilters>;
export type PlayerUpdate = z.infer<typeof playerUpdate>;
export type GameUpdate = z.infer<typeof gameUpdate>;
