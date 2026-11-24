import type { Context } from "hono";
import type { z } from "zod";
import { AppError } from "./errors";

export async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    const text = await c.req.text();
    if (text.length > 512_000) throw new AppError(422, "payload_too_large", "Request body too large");
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, "invalid_json", "Request body must be valid JSON");
  }
  return parseWith(schema, data);
}

export function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new AppError(422, "validation_failed", issues[0] ? `${issues[0].path ? `${issues[0].path}: ` : ""}${issues[0].message}` : "Invalid input", issues);
  }
  return result.data;
}

export function readQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query());
}
