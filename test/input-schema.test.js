import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Apify rejects a build when an input field is missing title/type/description, and only says so at build time.
const schema = JSON.parse(readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));

describe('.actor/input_schema.json', () => {
    it.each(Object.keys(schema.properties))('field %s has a title, type and description', (key) => {
        const field = schema.properties[key];
        expect(field.title, `${key}.title`).toBeTruthy();
        expect(field.type, `${key}.type`).toBeTruthy();
        expect(field.description, `${key}.description`).toBeTruthy();
    });

    it('every required field exists', () => {
        for (const key of schema.required ?? []) expect(schema.properties[key]).toBeDefined();
    });

    it('every enumTitles list matches its enum', () => {
        for (const [key, field] of Object.entries(schema.properties)) {
            if (field.enumTitles) expect(field.enumTitles, key).toHaveLength(field.enum.length);
        }
    });

    it('every default and prefill respects the field type', () => {
        const kind = (v) => {
            if (Array.isArray(v)) return 'array';
            if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
            return typeof v;
        };
        for (const [key, field] of Object.entries(schema.properties)) {
            for (const name of ['default', 'prefill']) {
                if (field[name] === undefined) continue;
                const got = kind(field[name]);
                const ok =
                    got === field.type ||
                    (field.type === 'number' && got === 'integer') ||
                    (field.type === 'object' && got === 'object');
                expect(ok, `${key}.${name} is ${got}, field type ${field.type}`).toBe(true);
            }
        }
    });
});
