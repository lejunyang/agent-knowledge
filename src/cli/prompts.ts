/**
 * CLI prompt abstraction keeps rich terminal interaction separate from workflow logic.
 *
 * Real TTY sessions use Inquirer select/checkbox/confirm controls. Tests and non-TTY helpers can
 * provide only `ask`, and the wrappers fall back to plain text without depending on terminal state.
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

export class InquirerPrompter implements InteractivePrompter {
  async ask(question: string): Promise<string> {
    return inquirerInput({ message: question });
  }

  async input(options: { message: string; defaultValue?: string }): Promise<string> {
    return inquirerInput({
      message: options.message,
      default: options.defaultValue
    });
  }

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

  async checkbox<T extends string>(options: {
    message: string;
    choices: Array<PromptChoice<T> & { checked?: boolean }>;
  }): Promise<T[]> {
    return inquirerCheckbox({
      message: options.message,
      choices: options.choices
    });
  }

  async confirm(options: { message: string; defaultValue: boolean }): Promise<boolean> {
    return inquirerConfirm({
      message: options.message,
      default: options.defaultValue
    });
  }

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

  close(): void {}
}

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
