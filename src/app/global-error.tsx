"use client"; // Error boundaries must be Client Components

import "./globals.css";
import { ErrorScreen } from "@/components/error-screen";

/** A crash in the root layout itself. It replaces the layout, so it brings its own html/body. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-background text-foreground">
        <ErrorScreen error={error} retry={retry} />
      </body>
    </html>
  );
}
