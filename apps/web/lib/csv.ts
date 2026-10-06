/**
 * The CSV reader lives in `@outreachgraph/domain`, so the CLI and the API read
 * a file exactly as this screen does. Re-exported here for the components that
 * already import it from this path.
 */

export { applyMapping, parseCsv, toCsv, type MappedRow } from '@outreachgraph/domain';
