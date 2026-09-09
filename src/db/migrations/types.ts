export interface Migration {
  /** Stable identifier, recorded in schema_migrations. Never change one. */
  id: string;
  sql: string;
}
