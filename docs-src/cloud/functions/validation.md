---
title: Function validation
description: Preview runtime validation for public function arguments and return values, generated TypeScript types, optional fields, unions, identifiers, and safe error messages.
slug: /functions/validation.html
availability: preview
updated: 2026-08-09
---
# Function validation

TypeScript protects code during development, but clients can call a public API without TypeScript. Public queries, mutations, and actions therefore need **runtime validation** for arguments and return values.

## Arguments

```ts
export const rename = mutation({
  args: {
    roomId: id('rooms'),
    name: string({ minLength: 1, maxLength: 120 }),
    color: optional(union(literal('blue'), literal('green'), literal('purple'))),
  },
  handler: async (ctx, args) => {
    // args is typed and already validated here.
  },
});
```

Validation rejects missing required properties, unexpected properties, incorrect primitive types, invalid identifiers, oversized strings and arrays, and values outside declared unions before customer code runs.

Even a function with no arguments declares `args: {}`. That rejects unexpected input and generates a zero-argument client signature.

## Return values

```ts
returns: object({
  id: id('rooms'),
  name: string(),
  memberCount: number(),
})
```

Return validation prevents accidental exposure of private columns and catches server/client drift immediately. If `returns` is omitted during Preview, the generated client uses the inferred TypeScript return type but the runtime cannot enforce it.

## Supported value shapes

The initial validator set covers null, boolean, finite number, string, bytes, timestamp, backend-scoped identifier, array, object, record, optional value, literal, and union.

Values must serialize to the documented wire format. Functions cannot return class instances, open streams, database clients, DOM objects, cyclic structures, `undefined` object properties, or arbitrary process handles.

## Generated TypeScript

Code generation combines function metadata and validators into an `api` object. The client receives exact argument and result types without importing server implementation code.

Generated types improve editor feedback but do not replace runtime validation. Treat the validator as the public security boundary and the generated type as developer ergonomics.

## Validation errors

Argument failures are application-facing errors with a stable code and a field path, such as `args.profile.displayName`. They must not include SQL, secrets, internal paths, or stack traces.

Return validation failures are developer errors. Production clients receive a generic server error and request identifier; protected logs retain the function name, validation path, and stack.

## Current custom functions

Current `handler(input, ctx)` functions receive untyped JSON and must validate it manually. Use explicit property allow-lists, string and array bounds, and predictable error codes. Do not assume a TypeScript annotation validated a network request.
