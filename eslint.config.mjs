import prettier from 'eslint-config-prettier';

import apify from '@apify/eslint-config/js.js';

// The Actors under actors/ are separate packages: they have their own tests (see .github/workflows/test.yaml) and are
// not held to this root project's lint rules.
// eslint-disable-next-line import-x/no-default-export
export default [{ ignores: ['**/dist', 'actors/**'] }, ...apify, prettier];
