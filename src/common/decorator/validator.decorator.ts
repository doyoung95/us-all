import {
  registerDecorator,
  ValidationArguments,
  ValidatorOptions,
} from 'class-validator';

export function AtLeastOneField(
  fields: string[],
  validationOptions?: ValidatorOptions,
) {
  return function (obj: object, propertyName: string) {
    registerDecorator({
      name: 'atLeastOneField',
      target: obj.constructor,
      propertyName,
      constraints: [fields],
      options: validationOptions,
      validator: {
        validate(_: unknown, args: ValidationArguments) {
          const [fields] = args.constraints;
          const obj = args.object as Record<string, unknown>;
          return fields.som((f: string) => obj[f] !== undefined);
        },
      },
    });
  };
}
