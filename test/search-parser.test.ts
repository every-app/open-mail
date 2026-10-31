// label: in the client's Gmail-style search parser (app/lib/search-parser.ts).
import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../app/lib/search-parser";

describe("parseSearchQuery: label:", () => {
	it("reads an unquoted name, slashes included", () => {
		expect(parseSearchQuery("label:Work invoice")).toEqual({ query: "invoice", label: "Work" });
		expect(parseSearchQuery("label:Work/Urgent")).toEqual({ query: "", label: "Work/Urgent" });
	});

	it("reads a quoted name with spaces and slashes", () => {
		expect(parseSearchQuery('from:alice label:"Work/Reports" order 1042')).toEqual({
			query: "order 1042",
			from: "alice",
			label: "Work/Reports",
		});
	});

	it("is case-insensitive in the operator and ignores an empty name", () => {
		expect(parseSearchQuery("LABEL:Work").label).toBe("Work");
		expect(parseSearchQuery('label:"" hello')).toEqual({ query: "hello" });
	});
});
