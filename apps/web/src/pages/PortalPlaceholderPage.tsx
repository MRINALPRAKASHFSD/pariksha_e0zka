import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface PortalPlaceholderProps {
  title: string;
  phase: string;
  description: string;
}

export function PortalPlaceholderPage({ title, phase, description }: PortalPlaceholderProps) {
  return (
    <div className="mx-auto max-w-4xl">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{title}</CardTitle>
            <Badge variant="outline">{phase}</Badge>
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This route is scaffolded in Phase 1 and will be backed by authenticated API endpoints and
          real PostgreSQL queries in {phase}.
        </CardContent>
      </Card>
    </div>
  );
}
