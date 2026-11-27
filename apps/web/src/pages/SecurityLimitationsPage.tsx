import { BROWSER_SECURITY_LIMITATIONS } from "@pariksha/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function SecurityLimitationsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Proctoring &amp; Browser Security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Privacy commitments and documented technical limits of browser-based proctoring.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Privacy by Default</CardTitle>
          <CardDescription>
            No raw webcam video or screen-share recordings are persisted or transmitted by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Camera and screen-sharing streams remain local to the candidate&apos;s browser for
            readiness verification and MediaStreamTrack continuity checks.
          </p>
          <Badge variant="outline">Client telemetry only — no video storage</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Technical Limitations of Browser Enforcement</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            {BROWSER_SECURITY_LIMITATIONS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
