import { migration as init } from './001_init.js';
import { migration as feedMessage } from './002_feed_message.js';
import type { Migration } from './types.js';

/**
 * Applied in array order. Append new migrations to the end; never reorder or
 * edit one that has shipped.
 *
 * Migrations are TypeScript modules rather than loose .sql files so that the
 * compiled image needs no asset-copy step and no runtime path resolution -
 * which is the usual way this breaks inside Docker.
 */
export const migrations: Migration[] = [init, feedMessage];

export type { Migration };
