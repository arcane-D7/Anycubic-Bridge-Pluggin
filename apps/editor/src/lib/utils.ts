import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui class combiner (MIT). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
