use ratatouille::{EmitResult, Format, Logger, LoggerConfig, Sink};
use std::cell::RefCell;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::rc::Rc;

#[derive(Default)]
struct Capture {
    last_line: Option<String>,
}

struct CaptureSink {
    state: Rc<RefCell<Capture>>,
}

impl Sink for CaptureSink {
    fn write_line(&mut self, line: &str) {
        self.state.borrow_mut().last_line = Some(line.to_owned());
    }
}

struct Session {
    logger: Logger<CaptureSink>,
    state: Rc<RefCell<Capture>>,
    filter: String,
}

fn parse_seq(line: &str) -> Option<u64> {
    let mark = line.find("\"seq\":")? + 6;
    let rest = &line[mark..];
    let end = rest.find(',').unwrap_or(rest.len());
    rest[..end].parse::<u64>().ok()
}

fn main() -> io::Result<()> {
    let path = env::args().nth(1).unwrap_or_else(|| "contract/cases.tsv".to_owned());
    let source = fs::read_to_string(path)?;
    let mut sessions: HashMap<String, Session> = HashMap::new();
    let mut cases = 0usize;

    for line in source.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() != 6 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid contract row"));
        }

        let session = sessions.entry(parts[0].to_owned()).or_insert_with(|| {
            let state = Rc::new(RefCell::new(Capture::default()));
            let mut config = LoggerConfig::default();
            if parts[1] != "-" {
                config.filter = Some(parts[1].to_owned());
            }
            config.format = Format::Ndjson;
            Session {
                logger: Logger::with_sink(config, CaptureSink { state: Rc::clone(&state) }),
                state,
                filter: parts[1].to_owned(),
            }
        });

        if session.filter != parts[1] {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "session changed filter"));
        }

        session.state.borrow_mut().last_line = None;
        let result = session.logger.log(parts[2], parts[3]);

        if parts[4] == "emit" {
            if result != EmitResult::Emitted {
                return Err(io::Error::other(format!(
                    "rust contract failed: expected emit for {}/{}",
                    parts[0], parts[2]
                )));
            }
            let line = session.state.borrow().last_line.clone().ok_or_else(|| {
                io::Error::other(format!("rust contract failed: missing line for {}/{}", parts[0], parts[2]))
            })?;
            let seq = parse_seq(&line).ok_or_else(|| io::Error::other("missing seq in output"))?;
            if seq.to_string() != parts[5] {
                return Err(io::Error::other(format!(
                    "rust contract failed: expected seq {} for {}/{} got {}",
                    parts[5], parts[0], parts[2], seq
                )));
            }
        } else if result != EmitResult::Filtered || session.state.borrow().last_line.is_some() {
            return Err(io::Error::other(format!(
                "rust contract failed: expected filter for {}/{}",
                parts[0], parts[2]
            )));
        }

        cases += 1;
    }

    println!("rust contract ok: {} cases", cases);
    Ok(())
}
