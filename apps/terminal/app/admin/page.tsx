"use client";
/**
 * Admin console (section 3.2 safety, section 4.6 alerting). Only the `PlatformConfig.admin`
 * key can sign anything here; everyone else sees who the admin is.
 */
import { EmptyState, Skeleton } from "@kydo/ui";
import { AlertsPanel } from "@/components/admin/AlertsPanel";
import { MarketsPanel } from "@/components/admin/MarketsPanel";
import { ParamsPanel } from "@/components/admin/ParamsPanel";
import { PoolsPanel } from "@/components/admin/PoolsPanel";
import { StatusPanel } from "@/components/admin/StatusPanel";
import { TreasuryPanel } from "@/components/admin/TreasuryPanel";
import { usePlatform } from "@/lib/platform";

export default function AdminPage() {
  const { config, wallet, chainError } = usePlatform();

  if (!config) {
    return (
      <div className="max-w-xl mx-auto mt-8 panel">
        {chainError ? (
          <EmptyState icon="⚠" title="Chain unreachable">
            {chainError}
          </EmptyState>
        ) : (
          <div className="p-4 flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton lines={3} />
          </div>
        )}
      </div>
    );
  }
  const admin = config.admin.toBase58();
  if (!wallet) {
    return (
      <div className="max-w-xl mx-auto mt-8 panel">
        <EmptyState icon="◎" title="Connect the admin wallet">
          Platform admin: <span className="num text-fg break-all">{admin}</span>
        </EmptyState>
      </div>
    );
  }
  if (!wallet.equals(config.admin)) {
    return (
      <div className="max-w-xl mx-auto mt-8 panel">
        <EmptyState icon="⛔" title="Not the admin">
          <div className="flex flex-col gap-1 text-left">
            <div className="kv">
              <span>Connected</span>
              <span>{wallet.toBase58()}</span>
            </div>
            <div className="kv">
              <span>Platform admin</span>
              <span>{admin}</span>
            </div>
            <div className="text-xxs pt-1">On a real deployment this key is the Squads multisig; the program rejects every admin instruction from any other signer.</div>
          </div>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="max-w-[1500px] mx-auto flex flex-col gap-3">
      <div className="grid grid-cols-[1.6fr_1fr] gap-3">
        <StatusPanel />
        <TreasuryPanel />
      </div>
      <AlertsPanel />
      <MarketsPanel />
      <ParamsPanel />
      <PoolsPanel />
    </div>
  );
}
