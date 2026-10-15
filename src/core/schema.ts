function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type, value) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return false;
}

/** `type` may be one name or an array of them, which JSON Schema reads as a choice. */
function typeMatches(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => matchesType(candidate, value));
}

function jsonEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function matchesPattern(pattern, key) {
  try {
    return new RegExp(pattern).test(key);
  } catch {
    // An unusable pattern cannot be satisfied; it also must not crash a check.
    return false;
  }
}

/** Whether a value satisfies a subschema, for anyOf / oneOf / allOf / not. */
function matchesSubschema(value, schema, path) {
  return validateJsonSchema(value, schema, path).length === 0;
}

export function validateJsonSchema(value, schema, path = "$") {
  const errors = [];

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
    return errors;
  }

  if (
    schema.enum &&
    !schema.enum.some((candidate) => jsonEqual(value, candidate))
  ) {
    errors.push(
      `${path}: expected one of ${schema.enum
        .map((candidate) => JSON.stringify(candidate))
        .join(", ")}`,
    );
    return errors;
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    const expected = Array.isArray(schema.type)
      ? schema.type.join(" or ")
      : schema.type;
    errors.push(`${path}: expected ${expected}, got ${describe(value)}`);
    return errors;
  }

  for (const branch of schema.allOf ?? []) {
    errors.push(...validateJsonSchema(value, branch, path));
  }
  if (
    schema.anyOf &&
    !schema.anyOf.some((branch) => matchesSubschema(value, branch, path))
  ) {
    errors.push(`${path}: does not match any allowed subschema`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) =>
      matchesSubschema(value, branch, path),
    ).length;
    if (matches !== 1) {
      errors.push(`${path}: expected exactly one matching subschema, got ${matches}`);
    }
  }
  if (schema.not && matchesSubschema(value, schema.not, path)) {
    errors.push(`${path}: matches a forbidden subschema`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !matchesPattern(schema.pattern, value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: smaller than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: larger than maximum ${schema.maximum}`);
    }
    if (
      schema.exclusiveMinimum !== undefined &&
      value <= schema.exclusiveMinimum
    ) {
      errors.push(
        `${path}: must be greater than exclusiveMinimum ${schema.exclusiveMinimum}`,
      );
    }
    if (
      schema.exclusiveMaximum !== undefined &&
      value >= schema.exclusiveMaximum
    ) {
      errors.push(
        `${path}: must be smaller than exclusiveMaximum ${schema.exclusiveMaximum}`,
      );
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items === false) {
      if (value.length > 0) errors.push(`${path}: items are not allowed`);
    } else if (Array.isArray(schema.items)) {
      // A tuple: each position has its own schema.
      value.forEach((item, index) => {
        const itemSchema = schema.items[index];
        if (itemSchema !== undefined) {
          errors.push(...validateJsonSchema(item, itemSchema, `${path}[${index}]`));
        } else if (schema.additionalItems === false) {
          errors.push(`${path}[${index}]: additional item is not allowed`);
        }
      });
    } else if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`));
      });
    }
  }

  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${path}.${key}: required property is missing`);
      }
    }

    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        errors.push(...validateJsonSchema(value[key], child, `${path}.${key}`));
      }
    }

    const patterns = Object.entries(schema.patternProperties ?? {});
    for (const key of Object.keys(value)) {
      for (const [pattern, child] of patterns) {
        if (matchesPattern(pattern, key)) {
          errors.push(...validateJsonSchema(value[key], child, `${path}.${key}`));
        }
      }
    }

    const declared = new Set(Object.keys(schema.properties ?? {}));
    const coveredByPattern = (key) =>
      patterns.some(([pattern]) => matchesPattern(pattern, key));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (declared.has(key) || coveredByPattern(key)) continue;
        errors.push(`${path}.${key}: additional property is not allowed`);
      }
    } else if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      for (const key of Object.keys(value)) {
        if (declared.has(key) || coveredByPattern(key)) continue;
        errors.push(
          ...validateJsonSchema(
            value[key],
            schema.additionalProperties,
            `${path}.${key}`,
          ),
        );
      }
    }
  }

  return errors;
}

export function assertJsonSchema(value, schema, label = "value") {
  const errors = validateJsonSchema(value, schema);
  if (errors.length > 0) {
    throw new Error(`${label} failed schema validation:\n- ${errors.join("\n- ")}`);
  }
  return value;
}
