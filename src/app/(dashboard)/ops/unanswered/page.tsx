"use client";

import { useTranslations } from "next-intl";
import { UnansweredBoard } from "@/components/ops/unanswered-board";

export default function UnansweredPage() {
  const t = useTranslations("Ops.unanswered");
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <UnansweredBoard />
    </div>
  );
}
