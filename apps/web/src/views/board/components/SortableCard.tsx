import Link from "next/link";
import { useRouter } from "next/router";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { env } from "next-runtime-env";
import { useEffect, useRef } from "react";

import type { CardDragData } from "../dnd/types";
import type { BoardCard } from "../types";
import CardPreview from "./CardPreview";

interface SortableCardProps {
  card: BoardCard;
  listPublicId: string;
  cardPrefix: string;
  cardHref: string;
  canEditCard: boolean;
  onContextMenu: (event: React.MouseEvent, cardPublicId: string) => void;
}

export default function SortableCard({
  card,
  listPublicId,
  cardPrefix,
  cardHref,
  canEditCard,
  onContextMenu,
}: SortableCardProps) {
  const isPlaceholder = card.publicId.startsWith("PLACEHOLDER");
  // Links like /boards/{id}?card={cardId} (from the factory dashboard) point at one card.
  const highlighted = useRouter().query.card === card.publicId;
  const cardRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    if (highlighted)
      cardRef.current?.scrollIntoView({ block: "center", inline: "center" });
  }, [highlighted]);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: card.publicId,
    data: { type: "CARD", listPublicId } satisfies CardDragData,
    disabled: !canEditCard || isPlaceholder,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <Link
      data-board-draggable
      onClick={(e) => {
        if (isPlaceholder) e.preventDefault();
      }}
      onContextMenu={(e) => {
        if (isPlaceholder || env("NEXT_PUBLIC_KAN_ENV") === "cloud") return;
        e.preventDefault();
        onContextMenu(e, card.publicId);
      }}
      href={cardHref}
      className={`mb-2 flex flex-col ${
        highlighted ? "rounded-md ring-2 ring-light-900 dark:ring-dark-900" : ""
      } ${isPlaceholder ? "pointer-events-none" : ""} ${
        canEditCard && !isPlaceholder && isDragging
          ? "cursor-grabbing"
          : "cursor-pointer"
      }`}
      ref={(node) => {
        cardRef.current = node;
        setNodeRef(node);
      }}
      aria-current={highlighted || undefined}
      style={style}
      {...attributes}
      {...listeners}
    >
      <CardPreview card={card} cardPrefix={cardPrefix} />
    </Link>
  );
}
