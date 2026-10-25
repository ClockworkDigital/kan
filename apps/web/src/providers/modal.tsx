import { createContext, useCallback, useContext, useState } from "react";

import type { NewCardInput } from "@kan/api/types";

import type { RouterOutputs } from "~/utils/api";

export interface ModalStateValues {
  NEW_CARD: NewCardInput & {
    isCreateAnotherEnabled: boolean;
    dueDate?: Date | null;
  };
  NEW_LABEL_CREATED: string;
  ADD_CHECKLIST: { createdChecklistId: string };
  CARD_CONTEXT_DUPLICATE: { boardPublicId: string; isTemplate?: boolean };
  EDIT_YOUTUBE: {
    url: string;
    title: string;
    onSave: (url: string, title: string) => void;
  };
  EDIT_WEBHOOK: Pick<
    RouterOutputs["webhook"]["list"][number],
    "publicId" | "name" | "url" | "events" | "active"
  >;
}

interface ModalState {
  contentType: string;
  entityId?: string;
  entityLabel?: string;
  closeOnClickOutside?: boolean;
}

interface Props {
  children: React.ReactNode;
}

interface ModalContextType {
  isOpen: boolean;
  openModal: (
    contentType: string,
    entityId?: string,
    entityLabel?: string,
    closeOnClickOutside?: boolean,
  ) => void;
  closeModal: () => void;
  closeModals: (count: number) => void;
  clearAllModals: () => void;
  modalContentType: string;
  entityId: string;
  entityLabel: string;
  closeOnClickOutside: boolean;
  modalStates: Partial<ModalStateValues>;
  setModalState: <Type extends keyof ModalStateValues>(
    modalType: Type,
    state: ModalStateValues[Type],
  ) => void;
  getModalState: <Type extends keyof ModalStateValues>(
    modalType: Type,
  ) => ModalStateValues[Type] | undefined;
  clearModalState: (modalType: keyof ModalStateValues) => void;
  clearAllModalStates: () => void;
}

const ModalContext = createContext<ModalContextType | undefined>(undefined);

export const ModalProvider: React.FC<Props> = ({ children }) => {
  const [modalStack, setModalStack] = useState<ModalState[]>([]);
  const [modalStates, setModalStates] = useState<Partial<ModalStateValues>>({});

  const isOpen = modalStack.length > 0;
  const currentModal = modalStack[modalStack.length - 1];
  const modalContentType = currentModal?.contentType ?? "";
  const entityId = currentModal?.entityId ?? "";
  const entityLabel = currentModal?.entityLabel ?? "";
  const closeOnClickOutside = currentModal?.closeOnClickOutside ?? true;

  const openModal = useCallback(
    (
      contentType: string,
      entityId?: string,
      entityLabel?: string,
      closeOnClickOutside?: boolean,
    ) => {
      const newModal: ModalState = {
        contentType,
        entityId,
        entityLabel,
        closeOnClickOutside,
      };
      setModalStack((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.contentType === newModal.contentType &&
          last.entityId === newModal.entityId &&
          last.entityLabel === newModal.entityLabel
        ) {
          return prev; // prevent stacking duplicate modal on top
        }
        return [...prev, newModal];
      });
    },
    [],
  );

  const closeModal = useCallback(() => {
    setModalStack((prev) => {
      if (prev.length <= 1) {
        return [];
      }
      return prev.slice(0, -1);
    });
  }, []);

  const closeModals = useCallback((count: number) => {
    setModalStack((prev) => {
      const newLength = Math.max(0, prev.length - count);
      return prev.slice(0, newLength);
    });
  }, []);

  const clearAllModals = useCallback(() => {
    setModalStack([]);
  }, []);

  const setModalState = useCallback(
    <Type extends keyof ModalStateValues>(
      modalType: Type,
      state: ModalStateValues[Type],
    ) => {
      setModalStates((prev) => ({
        ...prev,
        [modalType]: state,
      }));
    },
    [],
  );

  const getModalState = useCallback(
    <Type extends keyof ModalStateValues>(modalType: Type) => {
      return modalStates[modalType];
    },
    [modalStates],
  );

  const clearModalState = useCallback((modalType: keyof ModalStateValues) => {
    setModalStates((prev) => {
      const newStates = { ...prev };
      delete newStates[modalType];
      return newStates;
    });
  }, []);

  const clearAllModalStates = useCallback(() => {
    setModalStates({});
  }, []);

  return (
    <ModalContext.Provider
      value={{
        isOpen,
        openModal,
        closeModal,
        closeModals,
        clearAllModals,
        modalContentType,
        entityId,
        entityLabel,
        closeOnClickOutside,
        modalStates,
        setModalState,
        getModalState,
        clearModalState,
        clearAllModalStates,
      }}
    >
      {children}
    </ModalContext.Provider>
  );
};

export const useModal = () => {
  const context = useContext(ModalContext);
  if (context === undefined) {
    throw new Error("useModal must be used within a ModalProvider");
  }
  return context;
};
