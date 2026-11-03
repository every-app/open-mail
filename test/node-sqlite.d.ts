// node:sqlite (Node 22.5+; the tests run on Node 24) for the Gmail store's
// unit tests: the subset they use. @types/node 20 doesn't declare it.
declare module "node:sqlite" {
	export class DatabaseSync {
		constructor(path: string);
		prepare(sql: string): { all(...params: (string | number | null)[]): unknown[] };
		exec(sql: string): void;
	}
}
