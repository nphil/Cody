import type { Metadata } from "next";
import { StatisticsPage } from "@/components/statistics/StatisticsPage";
import { parseStatisticsInitial } from "@/components/statistics/statistics-query";

export const metadata: Metadata = { title: "Statistics · Cody" };

/**
 * The address carries the page's choices (range, grouping, metric), so a link
 * or a reload opens the same view. They are read here, on the server, so the
 * first paint already has them.
 */
export default async function StatisticsRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <StatisticsPage initial={parseStatisticsInitial(await searchParams)} />;
}
