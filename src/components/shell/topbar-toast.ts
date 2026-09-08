import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey, PlainMessageKey, Translate, TranslationArguments } from "../../i18n/core";
import {
  translateUiMessage,
  type UiErrorCode,
  type UiMessageDescriptor,
  uiError,
  uiMessage,
} from "../../i18n/errors";

export type TopBarToastDescriptor =
  | UiMessageDescriptor
  | { kind: "nextStep"; itemKey: PlainMessageKey };

export interface TopBarToastState {
  descriptor: TopBarToastDescriptor;
  id: number;
}

export interface TopBarToastActions {
  beginRequest: () => number;
  show: (descriptor: TopBarToastDescriptor, requestToken?: number) => boolean;
}

export interface TopBarToastController extends TopBarToastActions {
  toast: TopBarToastState | undefined;
}

export function toastMessage<Key extends MessageKey>(
  key: Key,
  ...values: TranslationArguments<Key>
): TopBarToastDescriptor {
  return uiMessage(key, ...values);
}

export function toastError(code: UiErrorCode): TopBarToastDescriptor {
  return uiError(code);
}

export function renderTopBarToast(t: Translate, descriptor: TopBarToastDescriptor): string {
  return descriptor.kind === "nextStep"
    ? t("topbar.toast.nextStep", { item: t(descriptor.itemKey) })
    : translateUiMessage(t, descriptor);
}

export function useTopBarToast(timeoutMs = 2400): TopBarToastController {
  const [toast, setToast] = useState<TopBarToastState>();
  const generationRef = useRef(0);
  const idRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const beginRequest = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);
  const show = useCallback(
    (descriptor: TopBarToastDescriptor, requestToken?: number) => {
      if (requestToken !== undefined && requestToken !== generationRef.current) return false;
      if (requestToken === undefined) generationRef.current += 1;
      const id = ++idRef.current;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      setToast({ descriptor, id });
      timerRef.current = window.setTimeout(() => {
        setToast((current) => (current?.id === id ? undefined : current));
        if (idRef.current === id) timerRef.current = undefined;
      }, timeoutMs);
      return true;
    },
    [timeoutMs],
  );
  useEffect(
    () => () => {
      generationRef.current += 1;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    },
    [],
  );
  return { beginRequest, show, toast };
}
