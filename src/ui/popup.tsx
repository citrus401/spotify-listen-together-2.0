import React from 'react';

const styles = {
  center: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  } as React.CSSProperties,
  button: {
    height: '32px',
  },
  flexContainer: {
    display: 'flex',
    flexDirection: 'column' as 'column',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '14px',
  } as React.CSSProperties,
  flexRow: {
    display: 'flex',
    flexDirection: 'row' as 'row',
    justifyContent: 'space-between',
    width: '100%',
  } as React.CSSProperties,
};

export namespace Popup {
  interface TextboxProps {
    name: string;
    example?: string;
    defaultValue?: string;
    onInput?: (value: string) => void;
    bottomSpace?: number;
  }

  export class Textbox extends React.Component<TextboxProps, {}> {
    constructor(props: TextboxProps) {
      super(props);
      if (props.defaultValue != undefined && this.props.onInput != undefined) {
        this.props.onInput(props.defaultValue);
      }
    }

    render() {
      return (
        <div style={styles.flexRow}>
          <div style={styles.center}>{this.props.name}</div>
          <div style={styles.center}>
            <input
              onInput={(e) => {
                if (this.props.onInput)
                  this.props.onInput(e.currentTarget.value);
              }}
              className="main-playlistEditDetailsModal-titleInput"
              type="text"
              defaultValue={this.props.defaultValue || ''}
              placeholder={this.props.example || ''}
            ></input>
          </div>
        </div>
      );
    }
  }

  interface TextProps {
    text: string;
    centered?: boolean;
    /** room codes */
    big?: boolean;
    bottomSpace?: number;
  }

  export class Text extends React.Component<TextProps, {}> {
    constructor(props: TextProps) {
      super(props);
    }

    render() {
      return (
        <div
          style={{
            ...styles.flexRow,
            justifyContent: this.props.centered ? 'center' : 'flex-start',
            textAlign: this.props.centered ? 'center' : 'left',
            ...(this.props.big
              ? { fontSize: '2rem', fontWeight: 700, letterSpacing: '0.15em', userSelect: 'text' }
              : {}),
          }}
        >
          {this.props.text}
        </div>
      );
    }
  }

  interface ButtonProps {
    text: string;
    onClick?: () => void;
    disabled?: boolean;
    bottomSpace?: number;
  }

  export class Button extends React.Component<ButtonProps, {}> {
    constructor(props: ButtonProps) {
      super(props);
    }

    render() {
      const { text, onClick, disabled } = this.props;

      return (
        <button
          className="button"
          data-encore-id="buttonSecondary"
          onClick={onClick}
          disabled={disabled}
        >
          {text}
        </button>
      );
    }
  }

  interface CheckboxProps {
    label: string;
    onChange?: (checked: boolean) => void;
    defaultChecked?: boolean;
    bottomSpace?: number;
  }
  export class Checkbox extends React.Component<CheckboxProps, {}> {
    constructor(props: CheckboxProps) {
      super(props);
    }

    render() {
      return (
        <div style={{ width: '100%' }} className="x-settings-row">
          <div className="x-settings-firstColumn">
            <label data-encore-id="type">{this.props.label}</label>
          </div>
          <div className="x-settings-secondColumn">
            <label className="x-toggle-wrapper">
              <input
                className="x-toggle-input"
                type="checkbox"
                defaultChecked={this.props.defaultChecked || false}
                onChange={(e) => {
                  if (this.props.onChange)
                    this.props.onChange(e.currentTarget.checked);
                }}
              />
              <span className="x-toggle-indicatorWrapper">
                <span className="x-toggle-indicator"></span>
              </span>
            </label>
          </div>
        </div>
      );
    }
  }

  interface SliderProps {
    label: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    unit?: string;
    /** only fires on release, every tick would mean a seek per pixel dragged */
    onCommit: (value: number) => void;
  }

  export class Slider extends React.Component<SliderProps, { value: number }> {
    constructor(props: SliderProps) {
      super(props);
      this.state = { value: props.defaultValue };
    }

    private commit = () => this.props.onCommit(this.state.value);

    render() {
      const { label, min, max, step, unit } = this.props;
      const { value } = this.state;
      return (
        <div style={{ width: '100%' }}>
          <div style={{ ...styles.flexRow, marginBottom: '6px' }}>
            <span>{label}</span>
            <span>
              {value > 0 ? '+' : ''}
              {value}
              {unit || ''}
            </span>
          </div>
          <input
            className="lt-slider"
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) =>
              this.setState({ value: Number(e.currentTarget.value) })
            }
            onPointerUp={this.commit}
            onKeyUp={this.commit}
          />
        </div>
      );
    }
  }

  export function close() {
    Spicetify.PopupModal.hide();
  }

  export function create(
    title: string,
    closed: (btnPressed: string | null) => void,
    buttonNames: string[],
    content: JSX.Element[],
  ) {
    setTimeout(() => {
      Spicetify.PopupModal.display({
        title: title,
        content: (
          <div style={styles.center}>
            <div style={styles.flexContainer}>
              {content}
              {buttonNames.length > 0 && (
                <div style={styles.flexRow}>
                  {buttonNames.map((btnName) => (
                    <Button
                      key={btnName}
                      text={btnName}
                      onClick={() => closed(btnName)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) as any,
      });
    }, 100);
  }
}
