import { useNavigate } from "react-router-dom";
import { ShieldX } from "lucide-react";
import { getHomeRouteForRole, useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function UnauthorizedPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-md py-12">
      <Card>
        <CardHeader className="text-center">
          <ShieldX className="mx-auto mb-2 h-10 w-10 text-destructive" />
          <CardTitle>Unauthorized Access</CardTitle>
          <CardDescription>
            Your account role does not have permission to view this section.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center gap-3">
          <Button
            onClick={() => navigate(user ? getHomeRouteForRole(user.role) : "/login", { replace: true })}
          >
            {user ? "Return to Dashboard" : "Go to Sign In"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
