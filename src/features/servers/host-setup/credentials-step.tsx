"use client";

import { ArrowLeft, CheckCircle2, Cloud, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/ui/log-console";
import { StatusDot } from "@/components/ui/status-pill";
import { AWS_REGIONS, AZURE_LOCATIONS, DO_REGIONS, GCP_REGIONS, LINODE_REGIONS, OCI_REGIONS } from "@/features/servers/host-setup/constants";
import { Field, Input, Nav, Note, Select, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";
import { openExternal } from "@/lib/failure";
import { useT } from "@/lib/i18n";

export function CredentialsStep({ s }: { s: HostSetup }) {
  const t = useT();
  const {
    v,
    error,
    signingIn,
    signInLog,
    editing,
    azure,
    gcp,
    digitalocean,
    linode,
    oci,
    ociCfg,
    tokenCloud,
    profiles,
    awsIdentity,
    checkingId,
    azureSubs,
    azureChecking,
    gcpBilling,
    gcpOrgs,
    gcpEmail,
    gcpChecking,
    awsSignIn,
    set,
    text,
    connectionOk,
    next,
    back,
    signIn,
  } = s;
  return (
    <Step
      icon={Cloud}
      title={
        azure
          ? t("servers.setup.credentials.titles.azure")
          : gcp
            ? t("servers.setup.credentials.titles.gcp")
            : digitalocean
              ? t("servers.setup.credentials.titles.digitalocean")
              : linode
                ? t("servers.setup.credentials.titles.linode")
                : oci
                  ? "Oracle Cloud"
                  : v.useCliCreds
                    ? "AWS CLI"
                    : t("servers.setup.credentials.titles.accessKeys")
      }
      description={
        azure
          ? t("servers.setup.credentials.descriptions.azure")
          : gcp
            ? t("servers.setup.credentials.descriptions.gcp")
            : tokenCloud
              ? t("servers.setup.credentials.descriptions.token", { cloud: digitalocean ? "DigitalOcean" : "Linode" })
              : oci
                ? t("servers.setup.credentials.descriptions.oci")
                : v.useCliCreds
                  ? t("servers.setup.credentials.descriptions.awsCli")
                  : t("servers.setup.credentials.descriptions.accessKeys")
      }
    >
      {oci ? (
        <div className="space-y-3">
          <Note className="flex flex-wrap items-center gap-2">
            {ociCfg?.configured ? (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="size-3.5" /> {t("servers.setup.credentials.ociFound")}
              </span>
            ) : (
              <span className="text-muted-foreground">{t("servers.setup.credentials.ociMissing")}</span>
            )}
            <button
              type="button"
              onClick={() => openExternal("https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm")}
              className="ml-auto inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
            >
              {t("servers.setup.credentials.howToSetUp")} <ExternalLink className="size-3" />
            </button>
          </Note>
          <Field label={t("servers.setup.credentials.compartment")} hint={t("servers.setup.credentials.compartmentHint")}>
            <Input {...text("username")} placeholder="ocid1.compartment.oc1..…" />
          </Field>
        </div>
      ) : tokenCloud ? (
        <div className="space-y-3">
          <Field label={t("servers.setup.credentials.apiToken")} hint={t("servers.setup.credentials.apiTokenHint")}>
            <Input
              type="password"
              value={v.password ?? ""}
              onChange={(e) => set("password", e.target.value || null)}
              placeholder={editing ? t("servers.setup.connection.keepPlaceholder") : digitalocean ? "dop_v1_…" : "…"}
              autoComplete="off"
            />
          </Field>
          <p className="text-[0.75rem] text-muted-foreground">
            {t("servers.setup.credentials.noToken")}{" "}
            <button
              type="button"
              onClick={() => openExternal(digitalocean ? "https://cloud.digitalocean.com/account/api/tokens" : "https://cloud.linode.com/profile/tokens")}
              className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
            >
              {t("servers.setup.credentials.createToken", { cloud: digitalocean ? "DigitalOcean" : "Linode" })} <ExternalLink className="size-3" />
            </button>
          </p>
        </div>
      ) : azure ? (
        <div className="space-y-3">
          {azureChecking ? (
            <Note className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> {t("servers.setup.credentials.checkingAzure")}
            </Note>
          ) : azureSubs.length > 0 ? (
            <>
              {/* The sign-in, its log, then the subscription it gives access to (as for GCP). */}
              <Note className="flex items-center gap-2">
                <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                <span className="text-muted-foreground">{t("servers.setup.credentials.signedInAzure")}</span>
                <button
                  type="button"
                  onClick={signIn}
                  disabled={signingIn}
                  className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  {signingIn ? t("servers.setup.credentials.signingIn") : t("servers.setup.credentials.switchAccount")}
                </button>
              </Note>
              {signInLog && <LogConsole lines={signInLog} running={signingIn} title={t("servers.setup.credentials.signInLog")} collapseOnDone />}
              <Field label={t("servers.setup.credentials.subscription")}>
                <Select value={v.username} onChange={(e) => set("username", e.target.value)}>
                  {!v.username && <option value="">{t("servers.setup.credentials.chooseSubscription")}</option>}
                  {azureSubs.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.name}
                      {sub.isDefault ? ` ${t("servers.setup.credentials.isDefault")}` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : (
            <>
              <Note className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t("servers.setup.credentials.azureSignInHint")}</span>
                <Button variant="outline" size="xs" className="ml-auto" onClick={signIn} disabled={signingIn}>
                  {signingIn ? <Spinner className="size-3" /> : null} {t("servers.setup.credentials.azureSignIn")}
                </Button>
              </Note>
              {signInLog && <LogConsole lines={signInLog} running={signingIn} title={t("servers.setup.credentials.signInLog")} collapseOnDone />}
              <Field label={t("servers.setup.credentials.subscriptionId")} hint={t("servers.setup.credentials.orPaste")}>
                <Input {...text("username")} placeholder="00000000-0000-0000-0000-000000000000" />
              </Field>
            </>
          )}
        </div>
      ) : gcp ? (
        <div className="space-y-3">
          {gcpChecking ? (
            <Note className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> {t("servers.setup.credentials.checkingGcloud")}
            </Note>
          ) : gcpEmail ? (
            <>
              {/* The sign-in, its log, then the billing account it gives access to. */}
              <Note className="flex items-center gap-2">
                <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground">{t("servers.setup.credentials.signedInAs")} </span>
                  <span className="text-foreground">{gcpEmail}</span>
                </span>
                <button
                  type="button"
                  onClick={signIn}
                  disabled={signingIn}
                  className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  {signingIn ? t("servers.setup.credentials.signingIn") : t("servers.setup.credentials.switchAccount")}
                </button>
              </Note>
              {signInLog && <LogConsole lines={signInLog} running={signingIn} title={t("servers.setup.credentials.signInLog")} collapseOnDone />}
              {gcpBilling.length > 0 ? (
                <Field label={t("servers.setup.credentials.billingAccount")} hint={t("servers.setup.credentials.billingHint")}>
                  <Select value={v.username} onChange={(e) => set("username", e.target.value)}>
                    {!v.username && <option value="">{t("servers.setup.credentials.chooseBilling")}</option>}
                    {gcpBilling.map((b) => (
                      <option key={b.id} value={b.id} disabled={!b.open}>
                        {b.name ? `${b.name} (${b.id})` : b.id}
                        {b.open ? "" : ` ${t("servers.setup.credentials.closed")}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field label={t("servers.setup.credentials.billingAccount")} hint={t("servers.setup.credentials.billingNone")}>
                  <Input {...text("username")} placeholder="0X0X0X-0X0X0X-0X0X0X" />
                </Field>
              )}
              <Field label={t("servers.setup.credentials.organization")}>
                <Select value={v.node ?? ""} onChange={(e) => set("node", e.target.value || null)}>
                  <option value="">{t("servers.setup.credentials.noOrganization")}</option>
                  {gcpOrgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name ? `${o.name} (${o.id})` : o.id}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : (
            <>
              <Note className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t("servers.setup.credentials.gcpSignInHint")}</span>
                <Button variant="outline" size="xs" className="ml-auto" onClick={signIn} disabled={signingIn}>
                  {signingIn ? <Spinner className="size-3" /> : null} {t("servers.setup.credentials.gcpSignIn")}
                </Button>
              </Note>
              {signInLog && <LogConsole lines={signInLog} running={signingIn} title={t("servers.setup.credentials.signInLog")} collapseOnDone />}
              <Field label={t("servers.setup.credentials.billingAccount")} hint={t("servers.setup.credentials.orType")}>
                <Input {...text("username")} placeholder="0X0X0X-0X0X0X-0X0X0X" />
              </Field>
            </>
          )}
        </div>
      ) : v.useCliCreds ? (
        <div className="space-y-3">
          {/* The sign-in, its log, then the profile (as for GCP and Azure). */}
          <Note className="flex flex-wrap items-center gap-2">
            {checkingId ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3.5" /> {t("servers.setup.credentials.checking")}
              </span>
            ) : awsIdentity ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                <span className="text-muted-foreground">{t("servers.setup.credentials.signedInAs")}</span>
                <span className="truncate text-foreground">{awsIdentity}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">{t("servers.setup.credentials.notSignedInProfile")}</span>
            )}
            <Button variant="outline" size="xs" className="ml-auto" onClick={awsSignIn} disabled={signingIn}>
              {signingIn ? <Spinner className="size-3" /> : null} {t("servers.setup.credentials.browserSignIn")}
            </Button>
          </Note>
          {signInLog && <LogConsole lines={signInLog} running={signingIn} title={t("servers.setup.credentials.signInLog")} collapseOnDone />}
          {profiles.length > 0 && (
            <Field label={t("servers.setup.credentials.profile")}>
              <Select value={v.awsProfile ?? ""} onChange={(e) => set("awsProfile", e.target.value || null)}>
                <option value="">default</option>
                {profiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("servers.setup.credentials.accessKeyId")} hint={t("servers.setup.credentials.accessKeyHint")}>
              <Input {...text("username")} placeholder="AKIA…" />
            </Field>
            <Field label={t("servers.setup.credentials.secretKey")} hint={t("servers.setup.connection.keychainHint")}>
              <Input
                type="password"
                value={v.password ?? ""}
                onChange={(e) => set("password", e.target.value || null)}
                placeholder={editing ? t("servers.setup.connection.keepPlaceholder") : ""}
                autoComplete="off"
              />
            </Field>
          </div>
          <p className="mt-1.5 text-[0.75rem] text-muted-foreground">
            {t("servers.setup.credentials.noKeys")}{" "}
            <button
              type="button"
              onClick={() => openExternal("https://console.aws.amazon.com/iam/home#/security_credentials")}
              className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
            >
              {t("servers.setup.credentials.createKeys")} <ExternalLink className="size-3" />
            </button>
          </p>
        </>
      )}
      <div className="mt-3">
        <Field label={azure ? t("servers.setup.credentials.location") : t("servers.setup.credentials.region")}>
          <Select value={v.host} onChange={(e) => set("host", e.target.value)}>
            {v.host &&
              !(azure ? AZURE_LOCATIONS : gcp ? GCP_REGIONS : digitalocean ? DO_REGIONS : linode ? LINODE_REGIONS : oci ? OCI_REGIONS : AWS_REGIONS).some(
                ([code]) => code === v.host,
              ) && <option value={v.host}>{v.host}</option>}
            {(azure ? AZURE_LOCATIONS : gcp ? GCP_REGIONS : digitalocean ? DO_REGIONS : linode ? LINODE_REGIONS : oci ? OCI_REGIONS : AWS_REGIONS).map(
              ([code, name]) => (
                <option key={code} value={code}>
                  {code} · {name}
                </option>
              ),
            )}
          </Select>
        </Field>
      </div>
      {error && (
        <Note className="mt-3 flex items-start gap-2.5">
          <StatusDot tone="fail" className="mt-1.5" />
          <span className="min-w-0 break-words text-muted-foreground">{error}</span>
        </Note>
      )}
      <Nav
        left={
          <Button variant="ghost" onClick={back}>
            <ArrowLeft className="size-4" /> {t("servers.setup.nav.back")}
          </Button>
        }
        right={
          <Button onClick={next} disabled={!connectionOk}>
            {t("servers.setup.nav.continue")}
          </Button>
        }
      />
    </Step>
  );
}
