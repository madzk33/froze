import robotsParser from "robots-parser";

export async function fetchRobots(startUrl, userAgent) {
  const robotsUrl = new URL("/robots.txt", startUrl).toString();
  try {
    const res = await fetch(robotsUrl, {
      headers: { "User-Agent": userAgent },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return robotsParser(robotsUrl, "");
    const body = await res.text();
    return robotsParser(robotsUrl, body);
  } catch {
    return robotsParser(robotsUrl, "");
  }
}

export function isAllowed(robots, url, userAgent, respect) {
  if (!respect) return true;
  try {
    return robots.isAllowed(url, userAgent) !== false;
  } catch {
    return true;
  }
}
