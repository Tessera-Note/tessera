import { Affix, Button } from "@mantine/core";
import { getAppUrl } from "@/lib/config.ts";

export default function ShareBranding() {
  return (
    <Affix position={{ bottom: 20, right: 20 }}>
      <Button
        variant="default"
        component="a"
        target="_blank"
        href={getAppUrl()}
      >
        Powered by Tessera
      </Button>
    </Affix>
  );
}
