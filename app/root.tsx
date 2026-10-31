// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { TriangleAlert } from "lucide-react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import { Toaster } from "sonner";
import { Button } from "~/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { TooltipProvider } from "~/components/ui/tooltip";
import { themePreferenceInitScript, useThemePreference } from "~/lib/theme";
import { ApiError } from "~/services/api";
import "./index.css";

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Global fallback for mutations that don't handle errors themselves.
				// Consumers using mutateAsync + try/catch handle their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return makeQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<meta charSet="UTF-8" />
				{/* Before any paint: the theme from localStorage or the system (no flash). */}
				<script dangerouslySetInnerHTML={{ __html: themePreferenceInitScript }} />
				<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
				<link
					rel="icon"
					type="image/x-icon"
					href="/favicon.ico"
					sizes="48x48 32x32 16x16"
				/>
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>OpenMail</title>
				<Meta />
				<Links />
			</head>
			<body className="bg-background text-foreground antialiased">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export function HydrateFallback() {
	return (
		<div className="flex h-screen items-center justify-center text-muted-foreground">
			<Spinner className="size-6" />
		</div>
	);
}

/**
 * Toasts in the app's theme, bottom-left (Gmail's corner). Sonner's "system"
 * follows prefers-color-scheme exactly as the app's "system" preference does.
 */
function ThemedToaster() {
	const { themePreference } = useThemePreference();
	return (
		<Toaster
			theme={themePreference}
			position="bottom-left"
			mobileOffset={{ bottom: 16 }}
		/>
	);
}

export default function App() {
	// Use useState to ensure each SSR request gets a fresh client while the
	// browser reuses the same singleton across navigations.
	const [queryClient] = useState(getQueryClient);
	return (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<Outlet />
				<ThemedToaster />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: { error: unknown }) {
	let title = "Something went wrong";
	let description: string | undefined;

	if (isRouteErrorResponse(error)) {
		if (error.status === 404) {
			title = "Page not found";
			description =
				"The page you're looking for doesn't exist or has been moved.";
		} else {
			title = `Error ${error.status}`;
			description = error.statusText || description;
		}
	} else if (error instanceof Error && import.meta.env.DEV) {
		description = error.message;
	}

	return (
		<div className="flex min-h-screen items-center justify-center p-8">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TriangleAlert />
					</EmptyMedia>
					<EmptyTitle>{title}</EmptyTitle>
					{description && <EmptyDescription>{description}</EmptyDescription>}
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() => {
							window.location.href = "/";
						}}
					>
						Back to mailboxes
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	);
}
