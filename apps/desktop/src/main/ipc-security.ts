/** Frontera mínima y testeable para validar el emisor de una llamada IPC. */

export interface TrustedWebContentsLike {
  readonly id: number;
  readonly mainFrame: unknown;
}

export interface IpcInvokeEventLike {
  readonly sender: { readonly id: number };
  readonly senderFrame: unknown;
}

/**
 * Solo el frame principal de la ventana principal puede invocar operaciones
 * privilegiadas. Iframes, ventanas auxiliares y renderers destruidos fallan
 * cerrados aunque conozcan el nombre de un canal.
 */
export function assertTrustedIpcSender(
  event: IpcInvokeEventLike,
  trustedContents: TrustedWebContentsLike | undefined,
): void {
  if (
    trustedContents === undefined ||
    event.sender.id !== trustedContents.id ||
    event.senderFrame !== trustedContents.mainFrame
  ) {
    throw new Error("Emisor IPC no autorizado");
  }
}
