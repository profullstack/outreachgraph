/**
 * `@outreachgraph/domain` — the canonical model shared by web, API and worker.
 *
 * This package holds types, enums and pure predicates only. It performs no I/O
 * and depends on no other workspace package, so every other package can import
 * it without a cycle (PRD §1.1 principle 3).
 */

export * from './ids';
export * from './networks';
export * from './confidence';
export * from './provenance';
export * from './person';
export * from './signal';
export * from './campaign';
export * from './pipeline';
export * from './outreach';
export * from './compliance';
