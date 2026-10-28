import assert from "node:assert/strict";
import type * as ReactModule from "react";
import type {
  ComponentProps,
  JSXElementConstructor,
  ReactElement,
  ReactNode,
} from "react";
import { Children, createElement, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Template } from "./TemplateBoards";
import type { RouterInputs, RouterOutputs } from "~/utils/api";
import Toggle from "~/components/Toggle";
import { NewBoardForm } from "./NewBoardForm";
import TemplateBoards from "./TemplateBoards";

interface FormValues {
  name: string;
  workspacePublicId: string;
  template: Template | null;
}

const state = vi.hoisted(() => {
  const initial: {
    templates: RouterOutputs["board"]["all"] | undefined;
    form: FormValues | undefined;
    showTemplates: boolean;
  } = { templates: undefined, form: undefined, showTemplates: false };
  return {
    ...initial,
    mutate: vi.fn<(input: RouterInputs["board"]["create"]) => void>(),
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useEffect: vi.fn(),
  useState: () => [
    state.showTemplates,
    (value: boolean) => {
      state.showTemplates = value;
    },
  ],
}));
vi.mock("react-hook-form", () => ({
  useForm: (options: { defaultValues: FormValues }) => {
    state.form ??= { ...options.defaultValues, name: "Synthetic board" };
    return {
      register: () => ({}),
      watch: () => state.form?.template ?? null,
      setValue: (_field: "template", value: Template | null) => {
        assert(state.form);
        state.form.template = value;
      },
      handleSubmit: (submit: (values: FormValues) => void) => () => {
        assert(state.form);
        submit(state.form);
      },
      formState: { errors: {} },
    };
  },
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: string[]) =>
    strings.reduce(
      (result, part, index) => result + part + (values[index] ?? ""),
      "",
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("~/providers/modal", () => ({
  useModal: () => ({ closeModal: vi.fn() }),
}));
vi.mock("~/providers/popup", () => ({
  usePopup: () => ({ showPopup: vi.fn() }),
}));
vi.mock("~/providers/workspace", () => ({
  useWorkspace: () => ({ workspace: { publicId: "workspace001" } }),
}));
vi.mock("~/utils/api", () => ({
  api: {
    useUtils: () => ({ board: { all: { refetch: vi.fn() } } }),
    board: {
      all: { useQuery: () => ({ data: state.templates }) },
      create: {
        useMutation: () => ({ mutate: state.mutate, isPending: false }),
      },
    },
  },
}));
vi.mock("~/components/Button", () => ({ default: () => null }));
vi.mock("~/components/Input", () => ({ default: () => null }));
vi.mock("~/components/Toggle", () => ({ default: () => null }));

const customTemplate: RouterOutputs["board"]["all"][number] = {
  publicId: "template0001",
  name: "Custom workflow",
  favorite: false,
  lists: [
    { publicId: "list00000001", name: "Ready", index: 0 },
    { publicId: "list00000002", name: "Done", index: 1 },
  ],
  labels: [{ publicId: "label0000001", name: "Urgent", colourCode: "#ff0000" }],
};

function findElement<Props>(
  tree: ReactNode,
  type: string | JSXElementConstructor<Props>,
): ReactElement<Props> | null {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type && isValidElement<Props>(child)) return child;
    const found = findElement<Props>(child.props.children, type);
    if (found) return found;
  }
  return null;
}

function renderForm() {
  const tree: ReactNode = NewBoardForm({});
  const toggle = findElement<ComponentProps<typeof Toggle>>(tree, Toggle);
  const templates = findElement<ComponentProps<typeof TemplateBoards>>(
    tree,
    TemplateBoards,
  );
  const form = findElement<{ onSubmit: () => void }>(tree, "form");
  assert(toggle && templates && form);
  return {
    toggle: toggle.props,
    templates: templates.props,
    submit: form.props.onSubmit,
  };
}

describe("NewBoardForm template selection and submission", () => {
  beforeEach(() => {
    // Next supplies the automatic JSX runtime; bare Vitest uses classic JSX.
    vi.stubGlobal("React", { createElement });
    state.templates = undefined;
    state.form = undefined;
    state.showTemplates = false;
    state.mutate.mockClear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults to the first custom template with its clone source and string names", () => {
    state.templates = [
      customTemplate,
      { ...customTemplate, publicId: "template0002", name: "Second" },
    ];
    renderForm().toggle.onChange();
    const form = renderForm();

    expect(form.toggle.isChecked).toBe(true);
    expect(form.templates.currentBoard).toEqual({
      id: "template0001",
      sourceBoardPublicId: "template0001",
      name: "Custom workflow",
      lists: ["Ready", "Done"],
      labels: ["Urgent"],
    });
    form.submit();
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith({
      name: "Synthetic board",
      workspacePublicId: "workspace001",
      sourceBoardPublicId: "template0001",
      lists: ["Ready", "Done"],
      labels: ["Urgent"],
      type: "regular",
    });
  });

  it("keeps the clone source when the custom template has no lists or labels", () => {
    state.templates = [{ ...customTemplate, lists: [], labels: [] }];
    renderForm().toggle.onChange();
    renderForm().submit();

    expect(state.mutate).toHaveBeenCalledExactlyOnceWith({
      name: "Synthetic board",
      workspacePublicId: "workspace001",
      sourceBoardPublicId: "template0001",
      lists: [],
      labels: [],
      type: "regular",
    });
  });

  it.each([undefined, []])(
    "keeps a null selection and empty submission for templates %j",
    (templates) => {
      state.templates = templates;
      renderForm().toggle.onChange();
      const form = renderForm();

      expect(form.templates.currentBoard).toBeNull();
      expect(form.templates.customTemplates).toEqual([]);
      form.submit();
      expect(state.mutate).toHaveBeenCalledExactlyOnceWith({
        name: "Synthetic board",
        workspacePublicId: "workspace001",
        sourceBoardPublicId: undefined,
        lists: [],
        labels: [],
        type: "regular",
      });
    },
  );

  it("preserves an explicit selection when templates are disabled and enabled again", () => {
    state.templates = [customTemplate];
    renderForm().toggle.onChange();
    const selected: Template = {
      id: "template0002",
      sourceBoardPublicId: "template0002",
      name: "Selected workflow",
      lists: ["Review"],
      labels: ["Feature"],
    };
    renderForm().templates.setCurrentBoard(selected);
    renderForm().toggle.onChange();
    expect(renderForm().toggle.isChecked).toBe(false);
    renderForm().toggle.onChange();
    const form = renderForm();

    expect(form.toggle.isChecked).toBe(true);
    expect(form.templates.currentBoard).toBe(selected);
    form.submit();
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith({
      name: "Synthetic board",
      workspacePublicId: "workspace001",
      sourceBoardPublicId: "template0002",
      lists: ["Review"],
      labels: ["Feature"],
      type: "regular",
    });
  });
});
