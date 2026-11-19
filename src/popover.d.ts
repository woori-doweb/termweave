// The Popover API's attributes, which @types/react 18 does not know yet; React 18 passes them
// through to the DOM as written (lowercase).
import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    popover?: "auto" | "manual" | "";
  }
}
