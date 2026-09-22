"use client";
import React from "react";
import { ToastProvider } from "@kydo/ui";
import { SolanaProviders } from "@/lib/solana";
import { PlatformProvider } from "@/lib/platform";

export function Providers({ children, rpcUrl }: { children: React.ReactNode; rpcUrl?: string }) {
  return (
    <ToastProvider>
      <SolanaProviders rpcUrl={rpcUrl}>
        <PlatformProvider>{children}</PlatformProvider>
      </SolanaProviders>
    </ToastProvider>
  );
}
