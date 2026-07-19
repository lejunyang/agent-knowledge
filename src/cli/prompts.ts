/**
 * CLI prompt 抽象把富终端交互和工作流逻辑分离。
 *
 * 真实 TTY 使用 Inquirer select/checkbox/confirm 控件；测试和非 TTY helper 只需提供 `ask`，
 * wrapper 会回退纯文本输入，不依赖终端状态。
 */
import {
  checkbox as inquirerCheckbox,
  confirm as inquirerConfirm,
  input as inquirerInput,
  number as inquirerNumber,
  select as inquirerSelect
} from "@inquirer/prompts";

export type PromptChoice<T extends string> = {
  name: string;
  value: T;
  description?: string;
};

export type InteractivePrompter = {
  ask(question: string): Promise<string>;
  input?(options: { message: string; defaultValue?: string }): Promise<string>;
  select?<T extends string>(options: {
    message: string;
    choices: PromptChoice<T>[];
    defaultValue: T;
  }): Promise<T>;
  checkbox?<T extends string>(options: {
    message: string;
    choices: Array<PromptChoice<T> & { checked?: boolean }>;
  }): Promise<T[]>;
  confirm?(options: { message: string; defaultValue: boolean }): Promise<boolean>;
  number?(options: { message: string; defaultValue: number; min?: number }): Promise<number>;
  close?(): void;
};

/** 把 Inquirer 的富交互控件适配为 CLI 流程使用的小型可注入 prompting 契约。 */
export class InquirerPrompter implements InteractivePrompter {
  /** 提供最小纯文本提问接口，供兼容 wrapper 和简单测试使用。 */
  async ask(question: string): Promise<string> {
    return inquirerInput({ message: question });
  }

  /** 调用 Inquirer 文本输入并传递已有默认值。 */
  async input(options: { message: string; defaultValue?: string }): Promise<string> {
    return inquirerInput({
      message: options.message,
      default: options.defaultValue
    });
  }

  /** 调用 Inquirer 单选控件，返回类型化 choice value。 */
  async select<T extends string>(options: {
    message: string;
    choices: PromptChoice<T>[];
    defaultValue: T;
  }): Promise<T> {
    return inquirerSelect({
      message: options.message,
      choices: options.choices,
      default: options.defaultValue
    });
  }

  /** 调用 Inquirer 多选控件，支持空格切换和回车确认。 */
  async checkbox<T extends string>(options: {
    message: string;
    choices: Array<PromptChoice<T> & { checked?: boolean }>;
  }): Promise<T[]> {
    return inquirerCheckbox({
      message: options.message,
      choices: options.choices
    });
  }

  /** 调用 Inquirer 确认控件并保留默认布尔值。 */
  async confirm(options: { message: string; defaultValue: boolean }): Promise<boolean> {
    return inquirerConfirm({
      message: options.message,
      default: options.defaultValue
    });
  }

  /** 调用 Inquirer 数字输入；用户未输入时回退调用方默认值。 */
  async number(options: { message: string; defaultValue: number; min?: number }): Promise<number> {
    const value = await inquirerNumber({
      message: options.message,
      default: options.defaultValue,
      min: options.min
    });
    if (value === undefined) {
      return options.defaultValue;
    }
    return value;
  }

  /** Inquirer 按调用完成即清理，保留空 close 以满足统一 prompter 生命周期。 */
  close(): void {}
}

/** 优先使用富文本输入；不可用时保持确定性的纯文本兼容行为。 */
export async function promptInput(
  prompter: InteractivePrompter,
  message: string,
  defaultValue: string
): Promise<string> {
  if (prompter.input) {
    return prompter.input({ message, defaultValue });
  }
  const answer = await prompter.ask(`${message} [${defaultValue}]: `);
  return answer.trim() || defaultValue;
}

/** 选择一个类型化值；简易 prompter 可直接返回原始值或接受默认值。 */
export async function promptSelect<T extends string>(
  prompter: InteractivePrompter,
  message: string,
  choices: PromptChoice<T>[],
  defaultValue: T
): Promise<T> {
  if (prompter.select) {
    return prompter.select({ message, choices, defaultValue });
  }
  const answer = await prompter.ask(
    `${message} (${choices.map((choice) => choice.value).join("/")}) [${defaultValue}]: `
  );
  return (answer.trim() || defaultValue) as T;
}

/** 收集多个类型化值；只有兼容 prompter 才使用逗号分隔文本。 */
export async function promptCheckbox<T extends string>(
  prompter: InteractivePrompter,
  message: string,
  choices: PromptChoice<T>[],
  defaults: T[]
): Promise<T[]> {
  if (prompter.checkbox) {
    return prompter.checkbox({
      message,
      choices: choices.map((choice) => ({
        ...choice,
        checked: defaults.includes(choice.value)
      }))
    });
  }
  const answer = await prompter.ask(
    `${message} (comma separated) [${defaults.join(",")}]: `
  );
  return (answer.trim() ? answer.split(",").map((value) => value.trim()).filter(Boolean) : defaults) as T[];
}

/** 统一富交互或文本 yes/no 答案，并拒绝含糊输入。 */
export async function promptConfirm(
  prompter: InteractivePrompter,
  message: string,
  defaultValue: boolean
): Promise<boolean> {
  if (prompter.confirm) {
    return prompter.confirm({ message, defaultValue });
  }
  const answer = (await prompter.ask(`${message} [${defaultValue ? "yes" : "no"}]: `))
    .trim()
    .toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  if (["y", "yes", "true", "1"].includes(answer)) {
    return true;
  }
  if (["n", "no", "false", "0"].includes(answer)) {
    return false;
  }
  throw new Error(`Expected yes/no, received: ${answer}`);
}

/** 解析整数，并在配置写入前执行调用方指定的下界校验。 */
export async function promptNumber(
  prompter: InteractivePrompter,
  message: string,
  defaultValue: number,
  min: number
): Promise<number> {
  if (prompter.number) {
    return prompter.number({ message, defaultValue, min });
  }
  const answer = await prompter.ask(`${message} [${defaultValue}]: `);
  const value = answer.trim() ? Number.parseInt(answer, 10) : defaultValue;
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Expected an integer >= ${min}, received: ${answer}`);
  }
  return value;
}
